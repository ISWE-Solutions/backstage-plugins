#!/usr/bin/env bash
# restore-instance.sh — restore a database dump into an EXISTING DHIS2
# instance. Renders an extra-vars file + minimal inventory and shells out
# to ansible-playbook restore.yml. Mirrors upgrade-instance.sh /
# clone-instance.sh — all secrets come from env vars, never argv.
#
# The restore spec (--restore-spec) is the same JSON the create flow
# consumes, written by the backend from the frontend's RestoreSource.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: restore-instance.sh [options]

Target instance:
  --vmid <int>              Target LXC VMID
  --node <name>             Proxmox node hosting the LXC
  --instance-name <name>    Backstage display name (inventory hostname)
  --hostname <name>         Container hostname (log lines only)
  --domain <fqdn[/segment]> Public FQDN — the segment becomes the
                            context path used by the health check

Restore source:
  --restore-spec <path>     JSON file describing the dump to restore.
                            Same shape as create-instance.sh consumes:
                            {"kind":"instance"|"upload"|"url"|"s3", ...}

Database (the target instance's own connection):
  --db-host <host>          DB host (default "localhost")
  --db-port <int>           DB port (default 5432)
  --db-name <name>          Database to drop, recreate and restore into
  --db-user <name>          Role that owns the restored database
  --db-admin-user <name>    Role used to drop/create (default --db-user)

SSH into the container:
  --ssh-user <name>         User inside the LXC (default "ansible")
  --ssh-key <path>          Private key for that user

Behaviour:
  --tomcat-service <name>   Override systemd unit (default "tomcat")
  --keep-vars-file          Don't delete the rendered work dir on exit
  -h | --help               Show this help

Environment (secrets — never passed on argv):
  DHIS2_DB_PASS             Password for --db-user
  DHIS2_DB_ADMIN_PASS       Password for --db-admin-user (default
                            DHIS2_DB_PASS)
  PROXMOX_API_URL           e.g. https://10.0.0.1:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (part after the !)
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    true|false (default false)
  DHIS2_DEBUG               1 to run ansible-playbook with -v
EOF
}

VMID=""
NODE=""
INSTANCE_NAME=""
HOSTNAME_=""
DOMAIN=""
RESTORE_SPEC=""
DB_HOST="localhost"
DB_PORT="5432"
DB_NAME=""
DB_USER=""
DB_ADMIN_USER=""
SSH_USER="ansible"
SSH_KEY="${SSH_KEY:-}"
TOMCAT_SERVICE="tomcat"
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --instance-name) INSTANCE_NAME="$2"; shift 2;;
        --hostname) HOSTNAME_="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --restore-spec) RESTORE_SPEC="$2"; shift 2;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --db-admin-user) DB_ADMIN_USER="$2"; shift 2;;
        --ssh-user) SSH_USER="$2"; shift 2;;
        --ssh-key) SSH_KEY="$2"; shift 2;;
        --tomcat-service) TOMCAT_SERVICE="$2"; shift 2;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

for var in VMID NODE INSTANCE_NAME DOMAIN RESTORE_SPEC DB_NAME DB_USER; do
    if [[ -z "${!var}" ]]; then
        echo "missing required flag for ${var}" >&2
        usage >&2
        exit 2
    fi
done

[[ -n "${HOSTNAME_}" ]] || HOSTNAME_="${INSTANCE_NAME}"
[[ -n "${DB_ADMIN_USER}" ]] || DB_ADMIN_USER="${DB_USER}"

if [[ -z "${PROXMOX_API_URL:-}" ]]; then
    echo "PROXMOX_API_URL is required (the playbook resolves the container IP via the API)" >&2
    exit 2
fi

_pve_api_host_port="${PROXMOX_API_URL#*://}"
_pve_api_host_port="${_pve_api_host_port%%/*}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[restore] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-restore-${VMID}-XXXXXX")"
EXTRA_VARS_FILE="${WORK_DIR}/vars.yml"
INVENTORY_FILE="${WORK_DIR}/hosts"

cleanup() {
    local rc=$?
    if [[ ${KEEP_VARS_FILE} -eq 1 ]]; then
        log "leaving working dir behind: ${WORK_DIR}"
    else
        rm -rf "${WORK_DIR}"
    fi
    return ${rc}
}
trap cleanup EXIT

yaml_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "${s}"
}

# A DB reachable only from inside the LXC ("localhost") makes the restore
# role run everything in-container; anything else makes it delegate to the
# orchestrator. This mirrors create-instance.sh's dhis2_db_remote rule and
# decides where the dump is staged.
if [[ -n "${DB_HOST}" && "${DB_HOST}" != "localhost" && "${DB_HOST}" != "127.0.0.1" && "${DB_HOST}" != "postgres" ]]; then
    DB_REMOTE=true
else
    DB_REMOTE=false
fi

# ----------------------------------------------------------------------------
# Translate the restore spec into the dhis2_restore extra-var
# ----------------------------------------------------------------------------
# Same rules as create-instance.sh: 'upload' needs the controller-side file
# copied into the container (or read in place when the DB is remote), and
# 'instance' only needs a destination path for the pg_dump the postgres
# role runs on the work host.
command -v jq >/dev/null || { echo "jq is required by restore-instance.sh" >&2; exit 2; }
[[ -r "${RESTORE_SPEC}" ]] || { echo "cannot read restore spec: ${RESTORE_SPEC}" >&2; exit 2; }

RESTORE_KIND="$(jq -r '.kind' "${RESTORE_SPEC}")"
log "restore kind=${RESTORE_KIND} target=${INSTANCE_NAME} (vmid=${VMID}) db=${DB_NAME}@${DB_HOST}"

RESTORE_CONTROLLER_PATH=""
RESTORE_STAGED_IN_CT=""

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
        for f in source_host source_db source_user source_password; do
            v="$(jq -r --arg k "$f" '.[$k] // empty' "${RESTORE_SPEC}")"
            [[ -n "$v" ]] || { echo "restore spec for kind=instance missing required field: $f" >&2; exit 2; }
        done
        RESTORE_STAGED_IN_CT="/var/lib/dhis2-restore/dump.dump"
        ;;
    url|s3)
        : # Fetched on the work host by the postgres role.
        ;;
    local|vzdump)
        echo "--restore-spec kind=${RESTORE_KIND} is not supported yet (needs SSH-to-PVE delegation)." >&2
        exit 2
        ;;
    *)
        echo "unsupported restore kind: ${RESTORE_KIND}" >&2; exit 2 ;;
esac

if [[ "${DB_REMOTE}" == "true" ]]; then
    _staged_for_yaml="${RESTORE_CONTROLLER_PATH:-${WORK_DIR}/dump.dump}"
else
    _staged_for_yaml="${RESTORE_STAGED_IN_CT}"
fi

RESTORE_YAML_BLOCK="$(
    jq -r --arg staged "${_staged_for_yaml}" \
          --arg ctrl "${RESTORE_CONTROLLER_PATH}" '
      . + (if .kind == "upload"
           then { local_staging_path: $staged, controller_path: $ctrl }
           elif .kind == "instance"
           then { local_staging_path: $staged }
           else {} end)
      | "dhis2_restore:\n" + (
          to_entries
          | map("  " + .key + ": " + (.value | @json))
          | join("\n")
        )
    ' "${RESTORE_SPEC}"
)"

# ----------------------------------------------------------------------------
# Render inventory + extra-vars
# ----------------------------------------------------------------------------
log "rendering extra-vars at ${EXTRA_VARS_FILE}"

cat > "${EXTRA_VARS_FILE}" <<EOF
---
# Rendered by restore-instance.sh — do not edit by hand.

# ---- Proxmox API (used only to resolve the container's IPv4) ----
pve_api_host: $(yaml_escape "${_pve_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER:-root@pam}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID:-}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET:-}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Target container ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}
pve_hostname: $(yaml_escape "${HOSTNAME_}")
instance_name: $(yaml_escape "${INSTANCE_NAME}")
fqdn: $(yaml_escape "${DOMAIN}")

# ---- SSH into the container ----
ansible_user_target: $(yaml_escape "${SSH_USER}")
ansible_ssh_private_key_file_orchestrator: $(yaml_escape "${SSH_KEY}")

# ---- Database being replaced ----
dhis2_db_host: $(yaml_escape "${DB_HOST}")
dhis2_db_port: ${DB_PORT}
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${DB_USER}")
dhis2_db_password: $(yaml_escape "${DHIS2_DB_PASS:-}")
dhis2_db_admin_user: $(yaml_escape "${DB_ADMIN_USER}")
dhis2_db_admin_password: $(yaml_escape "${DHIS2_DB_ADMIN_PASS:-${DHIS2_DB_PASS:-}}")
dhis2_db_remote: ${DB_REMOTE}

# ---- Service handles ----
tomcat_service_name: $(yaml_escape "${TOMCAT_SERVICE}")
EOF

printf '\n%s\n' "${RESTORE_YAML_BLOCK}" >> "${EXTRA_VARS_FILE}"
chmod 0600 "${EXTRA_VARS_FILE}"

cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local
EOF

log "running ansible-playbook restore.yml (vmid=${VMID}, db=${DB_NAME})"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    restore.yml

log "restore complete"
