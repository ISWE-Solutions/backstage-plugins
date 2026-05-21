#!/usr/bin/env bash
# provision-instance.sh — thin orchestrator for the hybrid Bash + Ansible
# DHIS2 provisioning flow.
#
#   1) create-container.sh    — Proxmox LXC + SSH bootstrap
#   2) ansible-playbook       — common + postgres + dhis2 (in-tree roles)
#   3) configure-host-proxy.sh — central Nginx + Let's Encrypt
#
# Secrets are taken from env vars or a --vars-file (mode 0600) — never argv.
# A temp vars.yml is rendered for Ansible and removed on exit via `trap`.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: provision-instance.sh [options]

Required:
  --vmid <int>              Proxmox VMID for the new container
  --node <name>             Proxmox node name
  --hostname <name>         Container hostname
  --domain <fqdn>           Public domain for the instance
  --email <addr>            Email for Let's Encrypt notifications
  --dhis2-version <ver>     DHIS2 version (e.g. 2.40, 2.42)
  --db-name <name>          PostgreSQL database name
  --db-user <name>          PostgreSQL user

Optional:
  --instance-name <name>    Logical name in the Ansible inventory (default: hostname)
  --cpu <int>               CPU cores            (default: 4)
  --memory <mb>             RAM in MB            (default: 8192)
  --storage <gb>            Root disk GB         (default: 100)
  --timezone <tz>           Default: Africa/Nairobi
  --postgres-version <int>  Default: 16
  --java-version <int>      Default: 17
  --ssh-key <path>          Orchestrator SSH private key
                            (default: \$HOME/.ssh/id_ed25519_dhis2 or id_ed25519)
  --ansible-user <name>     Default: ansible
  --vars-file <path>        YAML extra-vars file with secrets (mode 0600).
                            Overridden by env vars if both are set.
  --skip-certbot            Don't request a Let's Encrypt cert
  --rollback-on-failure     Destroy the container if anything fails
  --keep-vars-file          Don't delete the rendered vars.yml on exit
                            (debugging only)
  --restore-spec <path>     JSON file describing a database backup to restore
                            after provisioning. See docs for schema; supported
                            kinds: upload, url, s3, instance, vzdump, local.
                            For 'upload' the spec must include `staged_path`
                            (absolute path on this orchestrator host) which
                            will be pushed into the container.
  --new-db-user <name>      Provision an additional PostgreSQL role and use
                            it for the DHIS2 application connection. When
                            given, this role's credentials are written to
                            dhis.conf instead of --db-user. The --db-user
                            credentials are retained as the provisioning
                            (admin) role.
  --pve-host <host>         Proxmox node to drive over SSH for pct/pvesh/pvesm
                            operations. Leave empty (or set to localhost) when
                            this script is running directly on the PVE node.
                            When set, Ansible itself still runs from THIS host
                            and reaches the container via a ProxyCommand jump
                            through the PVE node.
  --pve-user <user>         SSH user for --pve-host (default: root)
  --pve-ssh-key <path>      SSH private key for --pve-host
  -h | --help               Show this help

Required env vars (or via --vars-file):
  DHIS2_DB_PASS             Postgres password for --db-user
  DHIS2_ADMIN_PASS          DHIS2 admin user initial password
  ROOT_PASSWORD             Container root password (console access only)
  NEW_DB_PASS               (optional) Password for --new-db-user. Required
                            when --new-db-user is set.
EOF
}

# Defaults
CPU=4
MEMORY=8192
STORAGE=100
TIMEZONE="Africa/Nairobi"
POSTGRES_VERSION=16
JAVA_VERSION=17
ANSIBLE_USER="ansible"
SKIP_CERTBOT=0
ROLLBACK_ON_FAILURE=0
KEEP_VARS_FILE=0
VARS_FILE=""
SSH_KEY=""
INSTANCE_NAME=""
RESTORE_SPEC=""
NEW_DB_USER=""
PVE_HOST=""
PVE_USER="root"
PVE_SSH_KEY=""

VMID=""; NODE=""; HOSTNAME=""; DOMAIN=""; EMAIL=""
DHIS2_VERSION=""; DB_NAME=""; DB_USER=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --hostname) HOSTNAME="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --email) EMAIL="$2"; shift 2;;
        --dhis2-version) DHIS2_VERSION="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --instance-name) INSTANCE_NAME="$2"; shift 2;;
        --cpu) CPU="$2"; shift 2;;
        --memory) MEMORY="$2"; shift 2;;
        --storage) STORAGE="$2"; shift 2;;
        --timezone) TIMEZONE="$2"; shift 2;;
        --postgres-version) POSTGRES_VERSION="$2"; shift 2;;
        --java-version) JAVA_VERSION="$2"; shift 2;;
        --ssh-key) SSH_KEY="$2"; shift 2;;
        --ansible-user) ANSIBLE_USER="$2"; shift 2;;
        --vars-file) VARS_FILE="$2"; shift 2;;
        --skip-certbot) SKIP_CERTBOT=1; shift;;
        --rollback-on-failure) ROLLBACK_ON_FAILURE=1; shift;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        --restore-spec) RESTORE_SPEC="$2"; shift 2;;
        --new-db-user) NEW_DB_USER="$2"; shift 2;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

# Validate required flags.
for var in VMID NODE HOSTNAME DOMAIN EMAIL DHIS2_VERSION DB_NAME DB_USER; do
    if [[ -z "${!var}" ]]; then
        echo "missing required flag for ${var}" >&2
        usage >&2
        exit 2
    fi
done
[[ -z "${INSTANCE_NAME}" ]] && INSTANCE_NAME="${HOSTNAME}"

# Locate paths.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PLUGIN_DIR="$(cd -- "${SCRIPT_DIR}/.." &>/dev/null && pwd)"
ANSIBLE_DIR="${PLUGIN_DIR}/ansible"

# Source PVE helper functions (pct / pvesh / pvesm become SSH-aware shims when
# --pve-host is set). Must come BEFORE any pct/pvesh/pvesm calls below.
# shellcheck source=./_pve_helpers.sh
source "${SCRIPT_DIR}/_pve_helpers.sh"

# Flags forwarded to sub-scripts (create-container.sh, configure-host-proxy.sh).
# Initialised here so the EXIT trap can safely expand it even if we fail
# before Phase 1 sets it.
PVE_FORWARD_FLAGS=()
if [[ -n "${PVE_HOST}" ]]; then
    PVE_FORWARD_FLAGS+=(--pve-host "${PVE_HOST}" --pve-user "${PVE_USER}")
    [[ -n "${PVE_SSH_KEY}" ]] && PVE_FORWARD_FLAGS+=(--pve-ssh-key "${PVE_SSH_KEY}")
fi

# Choose SSH key — default to a dhis2-specific key, fall back to id_ed25519.
if [[ -z "${SSH_KEY}" ]]; then
    if [[ -r "${HOME}/.ssh/id_ed25519_dhis2" ]]; then
        SSH_KEY="${HOME}/.ssh/id_ed25519_dhis2"
    elif [[ -r "${HOME}/.ssh/id_ed25519" ]]; then
        SSH_KEY="${HOME}/.ssh/id_ed25519"
    else
        echo "no SSH key found; pass --ssh-key <path>" >&2
        exit 2
    fi
fi
SSH_PUBKEY="${SSH_KEY}.pub"
[[ -r "${SSH_PUBKEY}" ]] || { echo "ssh pubkey missing: ${SSH_PUBKEY}" >&2; exit 2; }

# Secrets: prefer env vars; fall back to --vars-file (sourced lines like KEY=val).
if [[ -n "${VARS_FILE}" && -r "${VARS_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${VARS_FILE}"
fi
for var in DHIS2_DB_PASS DHIS2_ADMIN_PASS ROOT_PASSWORD; do
    if [[ -z "${!var:-}" ]]; then
        echo "missing secret env var: ${var} (set it or pass --vars-file)" >&2
        exit 2
    fi
done
if [[ -n "${NEW_DB_USER}" && -z "${NEW_DB_PASS:-}" ]]; then
    echo "--new-db-user requires NEW_DB_PASS env var (set it or pass --vars-file)" >&2
    exit 2
fi

# Sanity-check the in-tree role layout.
for role in common postgres dhis2; do
    if [[ ! -d "${ANSIBLE_DIR}/roles/${role}" ]]; then
        echo "missing Ansible role: ansible/roles/${role}" >&2
        exit 1
    fi
done

log() { printf '[provision] %s\n' "$*" >&2; }

# Workspace for rendered inventory + vars (under /run so it lives in tmpfs).
WORK_DIR="$(mktemp -d -t "dhis2-provision-${VMID}-XXXXXX")"
INVENTORY_FILE="${WORK_DIR}/hosts"
EXTRA_VARS_FILE="${WORK_DIR}/vars.yml"
IP_FILE="${WORK_DIR}/container-ip"

cleanup() {
    local rc=$?
    if [[ ${KEEP_VARS_FILE} -eq 1 ]]; then
        log "leaving working dir behind: ${WORK_DIR}"
    else
        rm -rf "${WORK_DIR}"
    fi
    if [[ ${rc} -ne 0 && ${ROLLBACK_ON_FAILURE} -eq 1 ]]; then
        log "FAILED (rc=${rc}) — rolling back"
        pct stop "${VMID}" 2>/dev/null || true
        pct destroy "${VMID}" --purge 2>/dev/null || true
        "${SCRIPT_DIR}/configure-host-proxy.sh" \
            --remove --vmid "${VMID}" --domain "${DOMAIN}" \
            "${PVE_FORWARD_FLAGS[@]}" 2>/dev/null || true
    fi
    return ${rc}
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# Phase 1: Proxmox LXC + SSH bootstrap
# ----------------------------------------------------------------------------
log "Phase 1 — creating LXC container"
ROLLBACK_FLAG=()
[[ ${ROLLBACK_ON_FAILURE} -eq 1 ]] && ROLLBACK_FLAG=(--rollback-on-failure)

ROOT_PASSWORD="${ROOT_PASSWORD}" "${SCRIPT_DIR}/create-container.sh" \
    --vmid "${VMID}" \
    --node "${NODE}" \
    --hostname "${HOSTNAME}" \
    --ssh-pubkey "${SSH_PUBKEY}" \
    --cpu "${CPU}" \
    --memory "${MEMORY}" \
    --storage "${STORAGE}" \
    --ansible-user "${ANSIBLE_USER}" \
    --ip-out-file "${IP_FILE}" \
    "${PVE_FORWARD_FLAGS[@]}" \
    "${ROLLBACK_FLAG[@]}"

CONTAINER_IP="$(cat "${IP_FILE}")"
log "container IP: ${CONTAINER_IP}"

# ----------------------------------------------------------------------------
# Phase 1b: Stage restore dump into the container (if --restore-spec given)
# ----------------------------------------------------------------------------
RESTORE_YAML_BLOCK=""
if [[ -n "${RESTORE_SPEC}" ]]; then
    if ! command -v jq >/dev/null; then
        echo "jq is required when --restore-spec is used" >&2
        exit 2
    fi
    [[ -r "${RESTORE_SPEC}" ]] || { echo "cannot read restore spec: ${RESTORE_SPEC}" >&2; exit 2; }

    RESTORE_KIND="$(jq -r '.kind' "${RESTORE_SPEC}")"
    log "Phase 1b — staging restore (kind=${RESTORE_KIND})"

    STAGED_IN_CT="/var/lib/dhis2-restore/dump.bin"

    case "${RESTORE_KIND}" in
        upload|local)
            # 'upload' = orchestrator host already has the file at .staged_path
            # 'local'  = file is on the Proxmox host at .path; we copy it into
            #            the container too (treat both the same way here).
            SRC_PATH="$(jq -r '.staged_path // .path' "${RESTORE_SPEC}")"
            [[ -r "${SRC_PATH}" ]] || { echo "restore source not readable: ${SRC_PATH}" >&2; exit 2; }
            # Preserve extension so .yml/restore.yml can decompress.
            EXT=""
            case "${SRC_PATH}" in
                *.sql.gz)  EXT=".sql.gz" ;;
                *.dump.gz) EXT=".dump.gz" ;;
                *.gz)      EXT=".gz" ;;
                *.zst)     EXT=".zst" ;;
                *.sql)     EXT=".sql" ;;
                *.dump|*.backup|*.pgdump) EXT=".dump" ;;
            esac
            STAGED_IN_CT="/var/lib/dhis2-restore/dump${EXT}"
            pct exec "${VMID}" -- mkdir -p /var/lib/dhis2-restore
            pct_push_local "${VMID}" "${SRC_PATH}" "${STAGED_IN_CT}"
            pct exec "${VMID}" -- chown postgres:postgres "${STAGED_IN_CT}"
            ;;
        vzdump)
            # .node + .storage + .volid (e.g. local:backup/vzdump-lxc-...tar.zst).
            # Extract the inner postgres dump on the Proxmox host, then push.
            if ! _pve_is_local; then
                echo "--restore-spec kind=vzdump is not yet supported when --pve-host is set" >&2
                echo "(extraction must happen on the PVE node; not implemented for remote mode)" >&2
                exit 2
            fi
            VOLID="$(jq -r '.volid' "${RESTORE_SPEC}")"
            INNER_PATH="$(jq -r '.inner_path // empty' "${RESTORE_SPEC}")"
            ARCHIVE_PATH="$(pvesm path "${VOLID}" 2>/dev/null || true)"
            [[ -n "${ARCHIVE_PATH}" && -r "${ARCHIVE_PATH}" ]] || {
                echo "cannot resolve vzdump archive for ${VOLID}" >&2; exit 2; }

            WORK_EXTRACT="${WORK_DIR}/vzdump-extract"
            mkdir -p "${WORK_EXTRACT}"
            log "extracting ${ARCHIVE_PATH}"
            case "${ARCHIVE_PATH}" in
                *.tar.zst|*.tzst) zstd -d --stdout "${ARCHIVE_PATH}" | tar -C "${WORK_EXTRACT}" -xf - ;;
                *.tar.gz|*.tgz)   tar -C "${WORK_EXTRACT}" -xzf "${ARCHIVE_PATH}" ;;
                *.tar.lzo)        tar -C "${WORK_EXTRACT}" --lzop -xf "${ARCHIVE_PATH}" ;;
                *.tar)            tar -C "${WORK_EXTRACT}" -xf "${ARCHIVE_PATH}" ;;
                *) echo "unsupported vzdump archive type: ${ARCHIVE_PATH}" >&2; exit 2 ;;
            esac

            if [[ -n "${INNER_PATH}" ]]; then
                CANDIDATE="${WORK_EXTRACT}/${INNER_PATH}"
            else
                # Heuristic: find the largest *.sql/*.dump/*.gz/*.zst file.
                CANDIDATE="$(find "${WORK_EXTRACT}" -type f \
                    \( -name '*.sql' -o -name '*.sql.gz' -o -name '*.dump' \
                       -o -name '*.dump.gz' -o -name '*.backup' -o -name '*.zst' \) \
                    -printf '%s\t%p\n' | sort -rn | head -1 | cut -f2-)"
            fi
            [[ -n "${CANDIDATE}" && -r "${CANDIDATE}" ]] || {
                echo "no database dump found inside vzdump archive" >&2; exit 2; }

            case "${CANDIDATE}" in
                *.sql.gz)  STAGED_IN_CT="/var/lib/dhis2-restore/dump.sql.gz" ;;
                *.dump.gz) STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump.gz" ;;
                *.gz)      STAGED_IN_CT="/var/lib/dhis2-restore/dump.gz" ;;
                *.zst)     STAGED_IN_CT="/var/lib/dhis2-restore/dump.zst" ;;
                *.sql)     STAGED_IN_CT="/var/lib/dhis2-restore/dump.sql" ;;
                *)         STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump" ;;
            esac
            pct exec "${VMID}" -- mkdir -p /var/lib/dhis2-restore
            pct_push_local "${VMID}" "${CANDIDATE}" "${STAGED_IN_CT}"
            pct exec "${VMID}" -- chown postgres:postgres "${STAGED_IN_CT}"
            ;;
        instance)
            # .source_host (resolvable) + .source_db + .source_user + .source_password
            SRC_HOST="$(jq -r '.source_host' "${RESTORE_SPEC}")"
            SRC_DB="$(jq -r '.source_db' "${RESTORE_SPEC}")"
            SRC_USER="$(jq -r '.source_user' "${RESTORE_SPEC}")"
            SRC_PASS="$(jq -r '.source_password // empty' "${RESTORE_SPEC}")"
            SRC_PORT="$(jq -r '.source_port // 5432' "${RESTORE_SPEC}")"
            DUMP_TMP="${WORK_DIR}/instance-dump.dump"
            log "pg_dump ${SRC_USER}@${SRC_HOST}:${SRC_PORT}/${SRC_DB}"
            PGPASSWORD="${SRC_PASS}" pg_dump \
                -h "${SRC_HOST}" -p "${SRC_PORT}" \
                -U "${SRC_USER}" -d "${SRC_DB}" \
                -Fc --no-owner --no-privileges \
                -f "${DUMP_TMP}"
            STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump"
            pct exec "${VMID}" -- mkdir -p /var/lib/dhis2-restore
            pct_push_local "${VMID}" "${DUMP_TMP}" "${STAGED_IN_CT}"
            pct exec "${VMID}" -- chown postgres:postgres "${STAGED_IN_CT}"
            rm -f "${DUMP_TMP}"
            ;;
        url|s3)
            : # No staging needed; Ansible fetches inside the container.
            ;;
        *)
            echo "unsupported restore kind: ${RESTORE_KIND}" >&2; exit 2 ;;
    esac

    # Build the dhis2_restore YAML block, injecting `local_staging_path`
    # for the staged kinds so restore.yml can find the file.
    RESTORE_YAML_BLOCK="$(
        jq -r --arg staged "${STAGED_IN_CT}" '
          . + (if (.kind == "upload" or .kind == "vzdump" or .kind == "instance")
               then { local_staging_path: $staged } else {} end)
          | "dhis2_restore:\n" + (
              to_entries
              | map("  " + .key + ": " + (.value | @json))
              | join("\n")
            )
        ' "${RESTORE_SPEC}"
    )"
fi

# ----------------------------------------------------------------------------
# Phase 2: Ansible — render inventory + extra-vars and run site.yml
# ----------------------------------------------------------------------------
log "Phase 2 — rendering inventory and extra-vars"

# When PVE is remote, Ansible (running on this host) reaches the container
# via a ProxyCommand jump through the PVE node. When PVE is local, no jump
# is needed and PROXY_JUMP_ARGS stays empty.
if _pve_is_local; then
    PROXY_JUMP_ARGS=""
else
    _pj_key=""
    [[ -n "${PVE_SSH_KEY}" ]] && _pj_key="-i ${PVE_SSH_KEY} "
    PROXY_JUMP_ARGS="-o ProxyCommand=\"ssh ${_pj_key}-o StrictHostKeyChecking=accept-new -o BatchMode=yes -W %h:%p ${PVE_USER}@${PVE_HOST}\""
fi

export CONTAINER_IP INSTANCE_NAME DHIS2_VERSION DOMAIN \
       EMAIL TIMEZONE POSTGRES_VERSION JAVA_VERSION \
       ANSIBLE_USER ANSIBLE_SSH_KEY="${SSH_KEY}" \
       LETSENCRYPT_EMAIL="${EMAIL}" \
       PROXY_JUMP_ARGS

envsubst \
    < "${ANSIBLE_DIR}/inventory/hosts.tmpl" \
    > "${INVENTORY_FILE}"

# Render vars.yml. Use single-quotes inside YAML to keep specials safe; the
# values themselves come from env, so embed via printf %q-ish quoting by
# rejecting any single quote in secrets (DHIS2 doesn't allow ' in passwords
# anyway via this path).
yaml_escape() {
    local val="$1"
    if [[ "${val}" == *"'"* ]]; then
        echo "secret contains a single quote, which is not supported" >&2
        exit 2
    fi
    printf "'%s'" "${val}"
}

# Decide which credentials DHIS2 itself uses (written into dhis.conf) and
# which are treated as the provisioning admin role. When --new-db-user is
# given the new role becomes the DHIS2 app role; otherwise the --db-user
# credentials serve both purposes (and are idempotently created/refreshed).
if [[ -n "${NEW_DB_USER}" ]]; then
    APP_DB_USER="${NEW_DB_USER}"
    APP_DB_PASS="${NEW_DB_PASS}"
else
    APP_DB_USER="${DB_USER}"
    APP_DB_PASS="${DHIS2_DB_PASS}"
fi

cat > "${EXTRA_VARS_FILE}" <<EOF
---
# Rendered by provision-instance.sh — do not edit by hand.
dhis2_version: $(yaml_escape "${DHIS2_VERSION}")
fqdn: $(yaml_escape "${DOMAIN}")
email: $(yaml_escape "${EMAIL}")
timezone: $(yaml_escape "${TIMEZONE}")
postgresql_version: ${POSTGRES_VERSION}
java_version: ${JAVA_VERSION}

# DB credentials consumed by the postgres + dhis2 roles.
# dhis2_db_user/password is what DHIS2 uses to connect (rendered into
# dhis.conf). dhis2_db_admin_user/password is the privileged provisioning
# role; when no --new-db-user is given they are the same.
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${APP_DB_USER}")
dhis2_db_password: $(yaml_escape "${APP_DB_PASS}")
dhis2_db_admin_user: $(yaml_escape "${DB_USER}")
dhis2_db_admin_password: $(yaml_escape "${DHIS2_DB_PASS}")
dhis2_admin_password: $(yaml_escape "${DHIS2_ADMIN_PASS}")
EOF
if [[ -n "${RESTORE_YAML_BLOCK}" ]]; then
    printf '\n%s\n' "${RESTORE_YAML_BLOCK}" >> "${EXTRA_VARS_FILE}"
fi
chmod 0600 "${EXTRA_VARS_FILE}"

log "running ansible-playbook (this can take a while)"
(
    cd "${ANSIBLE_DIR}"
    ANSIBLE_CONFIG="${ANSIBLE_DIR}/ansible.cfg" \
        ansible-playbook \
            -i "${INVENTORY_FILE}" \
            --extra-vars "@${EXTRA_VARS_FILE}" \
            site.yml
)

# ----------------------------------------------------------------------------
# Phase 3: central Nginx + certbot on the Proxmox host
# ----------------------------------------------------------------------------
log "Phase 3 — configuring central Nginx for ${DOMAIN}"
CERTBOT_FLAG=()
[[ ${SKIP_CERTBOT} -eq 1 ]] && CERTBOT_FLAG=(--skip-certbot)

"${SCRIPT_DIR}/configure-host-proxy.sh" \
    --vmid "${VMID}" \
    --container-ip "${CONTAINER_IP}" \
    --domain "${DOMAIN}" \
    --email "${EMAIL}" \
    "${PVE_FORWARD_FLAGS[@]}" \
    "${CERTBOT_FLAG[@]}"

log "================================================================"
log "DHIS2 provisioning complete"
log "  Container: VMID=${VMID} IP=${CONTAINER_IP}"
log "  URL:       https://${DOMAIN}/dhis"
log "  Admin:     username=admin (initial password set via DHIS2_ADMIN_PASS)"
log "================================================================"
log "Monitor startup: pct exec ${VMID} -- tail -f /var/lib/tomcat9/logs/catalina.out"
