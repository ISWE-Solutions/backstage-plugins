#!/usr/bin/env bash
# provision-instance.sh — thin wrapper around the Ansible DHIS2 playbook.
#
# All Proxmox interaction (LXC create/start + IP discovery) is now done by
# the `pve_lxc` Ansible role via the Proxmox REST API (community.general.
# proxmox + proxmoxer). There is no `pct`/`pvesh`/`pvesm` invocation
# anywhere in the bash side anymore.
#
# This script:
#   1. Parses CLI flags + reads secret env vars.
#   2. Renders a temp inventory (hosts) + an extra-vars YAML (vars.yml)
#      containing the container spec, DHIS2 vars, DB credentials, PVE API
#      credentials, and (optionally) a restore spec.
#   3. Runs `ansible-playbook site.yml`.
#   4. Runs configure-host-proxy.sh for central Nginx + Let's Encrypt.
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
  --timezone <tz>           Default: Africa/Lusaka
  --postgres-version <int>  Default: 16
  --java-version <int>      Default: 17
  --tomcat-version <9|10>   Apache Tomcat major version installed from
                            upstream archive. Default: 9. DHIS2 2.40/2.41
                            need 9 (javax); v42+ needs 10 (jakarta).
  --ssh-key <path>          Orchestrator SSH private key
                            (default: \$HOME/.ssh/id_ed25519_dhis2 or id_ed25519)
  --ansible-user <name>     In-container user the playbook will SSH as
                            (default: ansible)
  --vars-file <path>        YAML/env-style file with secrets (mode 0600).
                            Overridden by env vars if both are set.
  --skip-certbot            Don't request a Let's Encrypt cert
  --delete-if-exists        Stop + purge any existing LXC at VMID (and its
                            nginx vhost) before creating the new one.
                            Destructive — recreates from scratch.
  --rollback-on-failure     Destroy the container if anything fails
  --keep-vars-file          Don't delete the rendered vars.yml on exit
                            (debugging only)
  --restore-spec <path>     JSON file describing a database backup to restore
                            after provisioning. Supported kinds:
                            upload, url, s3, instance.
                            For 'upload'/'instance' the spec must include a
                            file readable by this orchestrator (key
                            `staged_path` for upload, generated for instance).
                            'local'/'vzdump' are NOT supported in the API-only
                            flow yet — they require SSH-to-PVE delegation.
  --new-db-user <name>      Provision an additional PostgreSQL role used
                            by the DHIS2 application; --db-user is kept as
                            the provisioning (admin) role.
  -h | --help               Show this help

Required env vars (or via --vars-file):
  DHIS2_DB_PASS             Postgres password for --db-user
  DHIS2_ADMIN_PASS          DHIS2 admin user initial password
  ROOT_PASSWORD             Container root password (console access only)
  NEW_DB_PASS               (optional) Password for --new-db-user. Required
                            when --new-db-user is set.
  PROXMOX_API_URL           Proxmox API base URL, e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (the part after !)
  PROXMOX_TOKEN_SECRET      API token secret (UUID)
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS cert validation (default: false)
EOF
}

# Defaults
CPU=4
MEMORY=8192
STORAGE=100
TIMEZONE="Africa/Lusaka"
POSTGRES_VERSION=16
JAVA_VERSION=17
TOMCAT_VERSION=9
ANSIBLE_USER="ansible"
SKIP_CERTBOT=0
ROLLBACK_ON_FAILURE=0
KEEP_VARS_FILE=0
VARS_FILE=""
SSH_KEY=""
INSTANCE_NAME=""
RESTORE_SPEC=""
NEW_DB_USER=""
DB_HOST=""
DB_PORT=""
EXISTING_DB=0
DELETE_IF_EXISTS=0

# Reverse-proxy server overrides forwarded from the DHIS2 Reverse Proxy
# panel (or per-instance overrides on the Create Instance dialog). When
# unset we fall back to the PVE_* values below so single-node setups keep
# working unchanged.
PROXY_HOST=""
PROXY_PORT=""
PROXY_USER=""
PROXY_SSH_KEY=""
PROXY_NGINX_DIR=""
PROXY_NGINX_RELOAD=""

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
        --tomcat-version) TOMCAT_VERSION="$2"; shift 2;;
        --ssh-key) SSH_KEY="$2"; shift 2;;
        --ansible-user) ANSIBLE_USER="$2"; shift 2;;
        --vars-file) VARS_FILE="$2"; shift 2;;
        --skip-certbot) SKIP_CERTBOT=1; shift;;
        --rollback-on-failure) ROLLBACK_ON_FAILURE=1; shift;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        --restore-spec) RESTORE_SPEC="$2"; shift 2;;
        --new-db-user) NEW_DB_USER="$2"; shift 2;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --existing-db) EXISTING_DB=1; shift;;
        --delete-if-exists) DELETE_IF_EXISTS=1; shift;;
        # Back-compat: accept and ignore the old PVE-SSH flags so callers
        # that still pass them don't break. The API-based flow doesn't
        # need them (configure-host-proxy.sh has its own --pve-host).
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        # Reverse-proxy SSH + layout overrides (forwarded from the
        # frontend's Reverse Proxy panel via the backend). All optional;
        # see PROXY_* defaults below.
        --proxy-host) PROXY_HOST="$2"; shift 2;;
        --proxy-port) PROXY_PORT="$2"; shift 2;;
        --proxy-user) PROXY_USER="$2"; shift 2;;
        --proxy-ssh-key) PROXY_SSH_KEY="$2"; shift 2;;
        --proxy-nginx-dir) PROXY_NGINX_DIR="$2"; shift 2;;
        --proxy-nginx-reload) PROXY_NGINX_RELOAD="$2"; shift 2;;
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

# Validate Tomcat major version. The Ansible dhis2 role looks up the
# archive URL in a small map keyed on this value.
case "${TOMCAT_VERSION}" in
    9|10) ;;
    *)
        echo "invalid --tomcat-version '${TOMCAT_VERSION}' (expected 9 or 10)" >&2
        exit 2
        ;;
esac

# Default PVE_HOST/USER for configure-host-proxy.sh (nginx + certbot still
# need to run ON the Proxmox node over SSH). When PROXMOX_API_URL is set
# we reuse its hostname (stripping scheme and port); the operator can
# override via env var.
_api_no_scheme="${PROXMOX_API_URL#*://}"   # strip https:// or http://
_api_host_port="${_api_no_scheme%%/*}"     # strip any trailing path
_api_host_only="${_api_host_port%%:*}"     # strip :port
PVE_HOST="${PVE_HOST:-${_api_host_only}}"
PVE_USER="${PVE_USER:-root}"
PVE_SSH_KEY="${PVE_SSH_KEY:-${SSH_KEY:-}}"

# Reverse-proxy server defaults. When the frontend didn't supply an
# explicit proxy host, fall back to the PVE host so legacy single-node
# setups (where central nginx runs on the Proxmox node itself) keep
# working unchanged.
PROXY_HOST="${PROXY_HOST:-${PVE_HOST}}"
PROXY_PORT="${PROXY_PORT:-22}"
PROXY_USER="${PROXY_USER:-${PVE_USER}}"
PROXY_SSH_KEY="${PROXY_SSH_KEY:-${PVE_SSH_KEY}}"

# Surface the resolved reverse-proxy target on stdout so the activity
# panel makes it obvious whether Phase 5 will SSH to the dedicated
# proxy server (panel-configured) or fall back to the PVE host. This
# was added after a deployment kept hitting the PVE node because the
# frontend's proxy panel settings weren't being forwarded; seeing the
# resolved values here is the fastest way to confirm the wiring on a
# live run.
printf '[provision] PVE host:    %s@%s\n' "${PVE_USER}" "${PVE_HOST}"
printf '[provision] proxy host:  %s@%s:%s\n' \
    "${PROXY_USER}" "${PROXY_HOST}" "${PROXY_PORT}"
if [[ -n "${PROXY_NGINX_DIR}" ]]; then
    printf '[provision] proxy nginx dir:    %s\n' "${PROXY_NGINX_DIR}"
fi
if [[ -n "${PROXY_NGINX_RELOAD}" ]]; then
    printf '[provision] proxy nginx reload: %s\n' "${PROXY_NGINX_RELOAD}"
fi
if [[ "${PROXY_HOST}" == "${PVE_HOST}" ]]; then
    printf '[provision] WARNING: proxy host equals PVE host — Phase 5 will SSH to the PVE node.\n' >&2
    printf '[provision]          Set host (and optionally ssh user/port/key) on the Reverse Proxy panel\n' >&2
    printf '[provision]          to route central-nginx work to a dedicated server.\n' >&2
fi

# Locate paths.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PLUGIN_DIR="$(cd -- "${SCRIPT_DIR}/.." &>/dev/null && pwd)"
ANSIBLE_DIR="${PLUGIN_DIR}/ansible"

# Source the orchestrator env file written by scripts/install.sh. This
# provides ANSIBLE_PYTHON_INTERPRETER (pointing at the venv that has
# proxmoxer installed) so the pve_lxc role can talk to the Proxmox REST
# API. Caller-set env vars win over the file (we don't clobber).
ORCH_ENV_FILE="${ORCH_ENV_FILE:-/etc/backstage/orchestrator.env}"
if [[ -r "${ORCH_ENV_FILE}" ]]; then
    while IFS= read -r _line; do
        [[ -z "${_line}" || "${_line}" =~ ^[[:space:]]*# ]] && continue
        _key="${_line%%=*}"
        _val="${_line#*=}"
        # Strip optional surrounding quotes.
        _val="${_val%\"}"; _val="${_val#\"}"
        _val="${_val%\'}"; _val="${_val#\'}"
        if [[ -z "${!_key:-}" ]]; then
            export "${_key}=${_val}"
        fi
    done < "${ORCH_ENV_FILE}"
    unset _line _key _val
fi
# Fallback: if no interpreter was set and the default install-time venv
# exists, use it so a stock install just works without an env file.
if [[ -z "${ANSIBLE_PYTHON_INTERPRETER:-}" \
      && -x "/opt/backstage/venv/bin/python3" ]]; then
    export ANSIBLE_PYTHON_INTERPRETER="/opt/backstage/venv/bin/python3"
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
SSH_PUBKEY_CONTENT="$(< "${SSH_PUBKEY}")"

# Secrets: prefer env vars; fall back to --vars-file.
if [[ -n "${VARS_FILE}" && -r "${VARS_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${VARS_FILE}"
fi
for var in DHIS2_DB_PASS DHIS2_ADMIN_PASS ROOT_PASSWORD \
           PROXMOX_API_URL PROXMOX_USER \
           PROXMOX_TOKEN_ID PROXMOX_TOKEN_SECRET; do
    if [[ -z "${!var:-}" ]]; then
        echo "missing required env var: ${var} (set it or pass --vars-file)" >&2
        exit 2
    fi
done

# Normalize PROXMOX_TOKEN_ID: community.general.proxmox + the curl auth
# header below both expect just the token *name* (e.g. "backstage"), not
# the full "user@realm!tokenname" form Proxmox shows in the UI. If the
# operator pasted the full form, strip the "<user>!" prefix so we don't
# end up with a doubled user component like "root@pam!root@pam!backstage",
# which the API rejects with '401 Unauthorized: no such user'.
if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    log "stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}"
    unset _orig_token_id
fi
if [[ -n "${NEW_DB_USER}" && -z "${NEW_DB_PASS:-}" ]]; then
    echo "--new-db-user requires NEW_DB_PASS env var (set it or pass --vars-file)" >&2
    exit 2
fi

# Sanity-check role layout (including the new ones).
for role in common postgres dhis2 pve_lxc lxc_bootstrap stage_restore proxy; do
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

cleanup() {
    local rc=$?
    if [[ ${KEEP_VARS_FILE} -eq 1 ]]; then
        log "leaving working dir behind: ${WORK_DIR}"
    else
        rm -rf "${WORK_DIR}"
    fi
    if [[ ${rc} -ne 0 && ${ROLLBACK_ON_FAILURE} -eq 1 ]]; then
        log "FAILED (rc=${rc}) — attempting LXC + nginx rollback via API"
        rollback_lxc || true
        "${SCRIPT_DIR}/configure-host-proxy.sh" \
            --remove --vmid "${VMID}" --domain "${DOMAIN}" \
            --pve-host "${PVE_HOST}" --pve-user "${PVE_USER}" \
            --pve-ssh-key "${PVE_SSH_KEY}" 2>/dev/null || true
    fi
    return ${rc}
}

# Best-effort rollback using the Proxmox REST API (curl, no ansible).
rollback_lxc() {
    local api_url="${PROXMOX_API_URL%/}/api2/json/nodes/${NODE}/lxc/${VMID}"
    local auth="Authorization: PVEAPIToken=${PROXMOX_USER}!${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}"
    local curl_opts=(-sk -H "${auth}")
    [[ "${PROXMOX_VALIDATE_CERTS:-false}" == "true" ]] && curl_opts=(-s -H "${auth}")
    curl "${curl_opts[@]}" -X POST "${api_url}/status/stop" >/dev/null 2>&1 || true
    sleep 3
    curl "${curl_opts[@]}" -X DELETE "${api_url}?purge=1" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# Restore spec validation (controller-side; staging happens in Ansible)
# ----------------------------------------------------------------------------
RESTORE_YAML_BLOCK=""
RESTORE_CONTROLLER_PATH=""
RESTORE_STAGED_IN_CT=""

if [[ -n "${RESTORE_SPEC}" ]]; then
    if ! command -v jq >/dev/null; then
        echo "jq is required when --restore-spec is used" >&2
        exit 2
    fi
    [[ -r "${RESTORE_SPEC}" ]] || { echo "cannot read restore spec: ${RESTORE_SPEC}" >&2; exit 2; }

    RESTORE_KIND="$(jq -r '.kind' "${RESTORE_SPEC}")"
    log "Restore kind=${RESTORE_KIND}"

    case "${RESTORE_KIND}" in
        upload)
            RESTORE_CONTROLLER_PATH="$(jq -r '.staged_path' "${RESTORE_SPEC}")"
            [[ -r "${RESTORE_CONTROLLER_PATH}" ]] || {
                echo "restore source not readable: ${RESTORE_CONTROLLER_PATH}" >&2; exit 2; }
            ext="${RESTORE_CONTROLLER_PATH##*.}"
            case "${RESTORE_CONTROLLER_PATH}" in
                *.sql.gz)  RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.sql.gz" ;;
                *.dump.gz) RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump.gz" ;;
                *.gz)      RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.gz" ;;
                *.zst)     RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.zst" ;;
                *.sql)     RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.sql" ;;
                *.dump|*.backup|*.pgdump) RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump" ;;
                *)         RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.${ext}" ;;
            esac
            ;;
        instance)
            SRC_HOST="$(jq -r '.source_host' "${RESTORE_SPEC}")"
            SRC_DB="$(jq -r '.source_db' "${RESTORE_SPEC}")"
            SRC_USER="$(jq -r '.source_user' "${RESTORE_SPEC}")"
            SRC_PASS="$(jq -r '.source_password // empty' "${RESTORE_SPEC}")"
            SRC_PORT="$(jq -r '.source_port // 5432' "${RESTORE_SPEC}")"
            RESTORE_CONTROLLER_PATH="${WORK_DIR}/instance-dump.dump"
            log "pg_dump ${SRC_USER}@${SRC_HOST}:${SRC_PORT}/${SRC_DB}"
            PGPASSWORD="${SRC_PASS}" pg_dump \
                -h "${SRC_HOST}" -p "${SRC_PORT}" \
                -U "${SRC_USER}" -d "${SRC_DB}" \
                -Fc --no-owner --no-privileges \
                -f "${RESTORE_CONTROLLER_PATH}"
            RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump"
            ;;
        url|s3)
            : # No staging needed; Ansible fetches inside the container.
            ;;
        local|vzdump)
            echo "--restore-spec kind=${RESTORE_KIND} is not supported in the API-only flow yet." >&2
            echo "(SSH-to-PVE delegation needed; not implemented in this version.)" >&2
            exit 2
            ;;
        *)
            echo "unsupported restore kind: ${RESTORE_KIND}" >&2; exit 2 ;;
    esac

    # Render the dhis2_restore YAML block. For staged kinds we inject both
    # controller_path (consumed by the stage_restore role) and
    # local_staging_path (consumed by the postgres role's restore tasks).
    #
    # When the operator has configured a shared PostgreSQL host (remote
    # mode), the postgres role runs the restore from the orchestrator and
    # therefore reads the dump in-place on the orchestrator filesystem —
    # so we override local_staging_path to equal controller_path. The
    # stage_restore role short-circuits in remote mode and never copies
    # the file into the LXC.
    if [[ -n "${DB_HOST}" && "${DB_HOST}" != "localhost" && "${DB_HOST}" != "127.0.0.1" && "${DB_HOST}" != "postgres" ]]; then
        _staged_for_yaml="${RESTORE_CONTROLLER_PATH}"
    else
        _staged_for_yaml="${RESTORE_STAGED_IN_CT}"
    fi
    RESTORE_YAML_BLOCK="$(
        jq -r --arg staged "${_staged_for_yaml}" \
              --arg ctrl "${RESTORE_CONTROLLER_PATH}" '
          . + (if (.kind == "upload" or .kind == "instance")
               then { local_staging_path: $staged, controller_path: $ctrl }
               else {} end)
          | "dhis2_restore:\n" + (
              to_entries
              | map("  " + .key + ": " + (.value | @json))
              | join("\n")
            )
        ' "${RESTORE_SPEC}"
    )"
fi

# ----------------------------------------------------------------------------
# Phase 1: render inventory + extra-vars
# ----------------------------------------------------------------------------
log "rendering inventory and extra-vars"

export INSTANCE_NAME DHIS2_VERSION DOMAIN \
       EMAIL TIMEZONE POSTGRES_VERSION JAVA_VERSION TOMCAT_VERSION \
       ANSIBLE_SSH_KEY="${SSH_KEY}" \
       LETSENCRYPT_EMAIL="${EMAIL}" \
       POSTGRESQL_VERSION="${POSTGRES_VERSION}" \
       ANSIBLE_VENV_PYTHON="${ANSIBLE_PYTHON_INTERPRETER:-/opt/backstage/venv/bin/python3}"

envsubst \
    < "${ANSIBLE_DIR}/inventory/hosts.tmpl" \
    > "${INVENTORY_FILE}"

# Render vars.yml. Reject single quotes in secrets (DHIS2 doesn't allow
# them anyway via this path).
yaml_escape() {
    local val="$1"
    if [[ "${val}" == *"'"* ]]; then
        echo "secret contains a single quote, which is not supported" >&2
        exit 2
    fi
    printf "'%s'" "${val}"
}

# Decide which credentials DHIS2 uses (written into dhis.conf) and which
# are the provisioning admin role.
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

# ---- Proxmox API credentials (consumed by the pve_lxc role) ----
# community.general.proxmox's api_host accepts host[:port] (no scheme),
# so we feed it the URL with the scheme stripped.
pve_api_host: $(yaml_escape "${_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Container spec ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}
pve_hostname: $(yaml_escape "${HOSTNAME}")
pve_cpu: ${CPU}
pve_memory: ${MEMORY}
pve_storage: ${STORAGE}
pve_root_password: $(yaml_escape "${ROOT_PASSWORD}")
pve_ssh_pubkey: $(yaml_escape "${SSH_PUBKEY_CONTENT}")
ansible_ssh_private_key_file_orchestrator: $(yaml_escape "${SSH_KEY}")

# ---- Bootstrap inside the new container ----
ansible_user_target: $(yaml_escape "${ANSIBLE_USER}")
ansible_user_pubkey: $(yaml_escape "${SSH_PUBKEY_CONTENT}")

# ---- Central Nginx (proxy role, Phase 5) ----
# SSH details for the dedicated reverse-proxy server. Defaults to the
# PVE node so single-node setups (where central nginx runs on Proxmox)
# keep working without any UI changes. The proxy_ssh_* extra-vars are
# what Phase 5a passes to add_host; pve_ssh_host is retained for
# back-compat (older inventory snippets still reference it).
pve_ssh_host: $(yaml_escape "${PVE_HOST}")
pve_ssh_user: $(yaml_escape "${PVE_USER}")
pve_ssh_key: $(yaml_escape "${PVE_SSH_KEY}")
proxy_ssh_host: $(yaml_escape "${PROXY_HOST}")
proxy_ssh_port: ${PROXY_PORT}
proxy_ssh_user: $(yaml_escape "${PROXY_USER}")
proxy_ssh_key: $(yaml_escape "${PROXY_SSH_KEY}")
host_proxy_skip_certbot: $(if [[ ${SKIP_CERTBOT} -eq 1 ]]; then echo true; else echo false; fi)
$(if [[ -n "${PROXY_NGINX_DIR}" ]]; then
    printf 'host_proxy_upstream_dir: %s\n' "$(yaml_escape "${PROXY_NGINX_DIR}")"
fi)
$(if [[ -n "${PROXY_NGINX_RELOAD}" ]]; then
    printf 'host_proxy_nginx_reload_cmd: %s\n' "$(yaml_escape "${PROXY_NGINX_RELOAD}")"
fi)

# ---- Logical naming + DHIS2 spec ----
instance_name: $(yaml_escape "${INSTANCE_NAME}")
dhis2_version: $(yaml_escape "${DHIS2_VERSION}")
fqdn: $(yaml_escape "${DOMAIN}")
email: $(yaml_escape "${EMAIL}")
timezone: $(yaml_escape "${TIMEZONE}")
postgresql_version: ${POSTGRES_VERSION}
java_version: ${JAVA_VERSION}
tomcat_version: ${TOMCAT_VERSION}

# ---- Database credentials (consumed by postgres + dhis2 roles) ----
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${APP_DB_USER}")
dhis2_db_password: $(yaml_escape "${APP_DB_PASS}")
dhis2_db_admin_user: $(yaml_escape "${DHIS2_DB_ADMIN_USER:-${DB_USER}}")
dhis2_db_admin_password: $(yaml_escape "${DHIS2_DB_ADMIN_PASS:-${DHIS2_DB_PASS}}")
dhis2_db_host: $(yaml_escape "${DB_HOST:-localhost}")
dhis2_db_port: ${DB_PORT:-5432}
# When dhis2_db_remote is true, the postgres role connects to the host above
# from the orchestrator instead of installing PostgreSQL inside the LXC.
dhis2_db_remote: $(if [[ -n "${DB_HOST}" && "${DB_HOST}" != "localhost" && "${DB_HOST}" != "127.0.0.1" && "${DB_HOST}" != "postgres" ]]; then echo true; else echo false; fi)
dhis2_db_existing: $(if [[ "${EXISTING_DB}" == "1" ]]; then echo true; else echo false; fi)
dhis2_admin_password: $(yaml_escape "${DHIS2_ADMIN_PASS}")
EOF
if [[ -n "${RESTORE_YAML_BLOCK}" ]]; then
    printf '\n%s\n' "${RESTORE_YAML_BLOCK}" >> "${EXTRA_VARS_FILE}"
fi
chmod 0600 "${EXTRA_VARS_FILE}"

# ----------------------------------------------------------------------------
# Phase 1.5 (optional): destructive wipe of any existing instance at this VMID
# ----------------------------------------------------------------------------
# When --delete-if-exists is passed, stop + purge the LXC at VMID and remove
# the matching nginx vhost on the Proxmox host before the playbook recreates
# them. Reuses the same Proxmox REST calls as rollback_lxc() and the
# --remove path of configure-host-proxy.sh. Safe to run even when nothing
# exists at VMID — both calls are best-effort and tolerate 404s.
if [[ "${DELETE_IF_EXISTS}" == "1" ]]; then
    log "--delete-if-exists set — wiping any existing VMID=${VMID} and its nginx vhost before recreating"
    rollback_lxc || true
    "${SCRIPT_DIR}/configure-host-proxy.sh" \
        --remove --vmid "${VMID}" --domain "${DOMAIN}" \
        --pve-host "${PVE_HOST}" --pve-user "${PVE_USER}" \
        --pve-ssh-key "${PVE_SSH_KEY}" 2>/dev/null || true
    # Give Proxmox a moment to release the VMID before the create call.
    sleep 2
fi

# ----------------------------------------------------------------------------
# Phase 2: ansible-playbook site.yml (LXC create + bootstrap + DHIS2)
# ----------------------------------------------------------------------------
log "Phase 2 — running ansible-playbook site.yml (this can take a while)"
# DHIS2_DEBUG=1 ⇒ pass -v and -e dhis2_debug=true so no_log gates in the
# pve_lxc / postgres roles open up and the real underlying error is shown.
#
# We deliberately stay at -v (not -vvv). -vvv emits the full ssh argv, the
# python module body, AND a complete YAML dump of every module return value
# on every task — for tasks like `systemd:` that dumps ~150 unit properties,
# each task emits several KB of stdout. Inside the Backstage backend
# (spawn(bash) | streamLines) that volume has been observed to back the
# stdout pipe up enough to silently stall ansible-playbook for ~10 minutes
# per task before something gives up and the playbook exits with code 2.
# -v gives us the task-level changed/ok/failed result (more than enough to
# tell what stage failed) without the verbose firehose.
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    log "DHIS2_DEBUG=1 — enabling -v and dhis2_debug=true"
    ANSIBLE_EXTRA_ARGS+=(-v -e "dhis2_debug=true")
fi
(
    cd "${ANSIBLE_DIR}"
    ANSIBLE_CONFIG="${ANSIBLE_DIR}/ansible.cfg" \
        ansible-playbook \
            -i "${INVENTORY_FILE}" \
            --extra-vars "@${EXTRA_VARS_FILE}" \
            "${ANSIBLE_EXTRA_ARGS[@]}" \
            site.yml
)

# The pve_lxc role discovered the container's IP via the API and wrote it
# into the inventory at runtime. To get it back into this shell (for the
# success banner below) we re-query the API directly. Phase 5 of site.yml
# (the host_proxy role) owns the central-nginx config now; it pulls the
# IP straight out of the Ansible inventory so this re-query is purely
# informational for the operator-facing log line.
log "querying container IP via Proxmox API"
CONTAINER_IP="$(
    curl -sk \
        -H "Authorization: PVEAPIToken=${PROXMOX_USER}!${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}" \
        "${PROXMOX_API_URL%/}/api2/json/nodes/${NODE}/lxc/${VMID}/interfaces" \
    | jq -r '.data[] | select(.name!="lo") | .inet // empty' \
    | grep -v '^127\.' | head -1 | cut -d/ -f1
)"
[[ -n "${CONTAINER_IP}" ]] || { echo "could not resolve container IP via API" >&2; exit 1; }
log "container IP: ${CONTAINER_IP}"

# ----------------------------------------------------------------------------
# Phase 3 (legacy): central Nginx + certbot on the Proxmox host
# ----------------------------------------------------------------------------
# NOTE: this phase has been moved into the Ansible playbook (site.yml
# Phase 5, roles/host_proxy). The legacy configure-host-proxy.sh script
# is still used for the rollback / --delete-if-exists tear-down path
# above; the create path is now driven by Ansible end-to-end.

log "================================================================"
log "DHIS2 provisioning complete"
log "  Container: VMID=${VMID} IP=${CONTAINER_IP}"
log "  URL:       https://${DOMAIN}/dhis"
log "  Admin:     username=admin (initial password set via DHIS2_ADMIN_PASS)"
log "================================================================"
