#!/usr/bin/env bash
# upgrade-instance.sh — upgrade the DHIS2 WAR of an existing LXC instance
# in place. Renders an extra-vars file + minimal inventory and shells out
# to ansible-playbook upgrade.yml. Mirrors clone-instance.sh / lifecycle-
# instance.sh — all secrets come from env vars, never argv.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: upgrade-instance.sh [options]

Target instance:
  --vmid <int>              Target LXC VMID
  --node <name>             Proxmox node hosting the LXC
  --hostname <name>         Container hostname (for log lines)
  --instance-name <name>    Backstage display name (for STEP_DONE / logs)
  --domain <fqdn[/segment]> Public FQDN — picks ROOT.war vs <segment>.war
  --to-version <label>      New DHIS2 version (e.g. 2.41.3 or 41.2.0)

Upgrade source:
  --war-url <url>           Explicit WAR URL (overrides the derivation
                            from --to-version). Optional.
  --war-file <path>         Pre-staged WAR file on the PVE host (skips
                            download; takes precedence over --war-url).

Behaviour:
  --no-backup-db            Skip the pre-upgrade pg_dump snapshot
  --backup-retain <n>       Keep last N pre-upgrade backup dirs (default 3)
  --tomcat-service <name>   Override systemd unit (default "tomcat")
  --webapps-dir <path>      Override Tomcat webapps dir (default
                            "/opt/tomcat/webapps")

Database (used only when --no-backup-db is NOT passed):
  --db-host <host>          DB host (default "localhost")
  --db-port <int>           DB port (default 5432)
  --db-name <name>          DHIS2 database name
  --db-user <name>          DB user with pg_dump rights

Proxmox SSH (defaults to PVE host derived from PROXMOX_API_URL):
  --pve-host <host>         SSH target for `pct push/exec`
  --pve-port <int>          SSH port (default 22)
  --pve-user <name>         SSH user (default root)
  --pve-ssh-key <path>      SSH private key for the PVE host

  --keep-vars-file          Don't delete the rendered vars.yml on exit
  -h | --help               Show this help

Required env vars (Proxmox REST API credentials):
  PROXMOX_API_URL           e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (the part AFTER the `!`)
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS validation (default: false)

Required env var when backing up the database (default):
  DHIS2_DB_PASS             Password for --db-user (used by pg_dump)
EOF
}

VMID=""
NODE=""
HOSTNAME_=""
INSTANCE_NAME=""
DOMAIN=""
TO_VERSION=""
WAR_URL=""
WAR_FILE=""
BACKUP_DB=1
BACKUP_RETAIN="3"
TOMCAT_SERVICE="tomcat"
WEBAPPS_DIR="/opt/tomcat/webapps"
DB_HOST="localhost"
DB_PORT="5432"
DB_NAME=""
DB_USER=""
PVE_HOST=""
PVE_PORT="22"
PVE_USER="root"
PVE_SSH_KEY=""
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --hostname) HOSTNAME_="$2"; shift 2;;
        --instance-name) INSTANCE_NAME="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --to-version) TO_VERSION="$2"; shift 2;;
        --war-url) WAR_URL="$2"; shift 2;;
        --war-file) WAR_FILE="$2"; shift 2;;
        --no-backup-db) BACKUP_DB=0; shift;;
        --backup-retain) BACKUP_RETAIN="$2"; shift 2;;
        --tomcat-service) TOMCAT_SERVICE="$2"; shift 2;;
        --webapps-dir) WEBAPPS_DIR="$2"; shift 2;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-port) PVE_PORT="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

for k in VMID NODE HOSTNAME_ INSTANCE_NAME DOMAIN TO_VERSION; do
    if [[ -z "${!k}" ]]; then
        echo "Missing required --${k,,}" >&2
        exit 2
    fi
done

if [[ ${BACKUP_DB} -eq 1 ]]; then
    if [[ -z "${DB_NAME}" || -z "${DB_USER}" ]]; then
        echo "--db-name and --db-user are required unless --no-backup-db is passed" >&2
        exit 2
    fi
    : "${DHIS2_DB_PASS:?missing DHIS2_DB_PASS (required for pre-upgrade pg_dump)}"
fi

: "${PROXMOX_API_URL:?missing PROXMOX_API_URL}"
: "${PROXMOX_USER:?missing PROXMOX_USER}"
: "${PROXMOX_TOKEN_ID:?missing PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?missing PROXMOX_TOKEN_SECRET}"
PROXMOX_VALIDATE_CERTS="${PROXMOX_VALIDATE_CERTS:-false}"

if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    echo "[upgrade] stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}" >&2
    unset _orig_token_id
fi

_pve_api_host_port="${PROXMOX_API_URL#*://}"
_pve_api_host_port="${_pve_api_host_port%%/*}"
_pve_api_host_only="${_pve_api_host_port%%:*}"
PVE_HOST="${PVE_HOST:-${_pve_api_host_only}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[upgrade] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-upgrade-${VMID}-XXXXXX")"
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

log "rendering extra-vars at ${EXTRA_VARS_FILE}"

cat > "${EXTRA_VARS_FILE}" <<EOF
---
# Rendered by upgrade-instance.sh — do not edit by hand.

# ---- Proxmox API ----
pve_api_host: $(yaml_escape "${_pve_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Target identity ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}
pve_hostname: $(yaml_escape "${HOSTNAME_}")
instance_name: $(yaml_escape "${INSTANCE_NAME}")
fqdn: $(yaml_escape "${DOMAIN}")
dhis2_version: $(yaml_escape "${TO_VERSION}")

# ---- WAR source ----
dhis2_war_url: $(yaml_escape "${WAR_URL}")
dhis2_war_file: $(yaml_escape "${WAR_FILE}")

# ---- Backup behaviour ----
upgrade_backup_db: $([[ "${BACKUP_DB}" == "1" ]] && echo true || echo false)
upgrade_backup_retain: ${BACKUP_RETAIN}

# ---- Tomcat layout ----
tomcat_service_name: $(yaml_escape "${TOMCAT_SERVICE}")
tomcat_webapps_dir: $(yaml_escape "${WEBAPPS_DIR}")

# ---- DB connection (used by pg_dump when upgrade_backup_db=true) ----
dhis2_db_host: $(yaml_escape "${DB_HOST}")
dhis2_db_port: ${DB_PORT}
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${DB_USER}")
dhis2_db_password: $(yaml_escape "${DHIS2_DB_PASS:-}")

# ---- SSH to PVE host for pct push/exec ----
pve_ssh_host: $(yaml_escape "${PVE_HOST}")
pve_ssh_port: ${PVE_PORT}
pve_ssh_user: $(yaml_escape "${PVE_USER}")
pve_ssh_key: $(yaml_escape "${PVE_SSH_KEY}")
EOF
chmod 0600 "${EXTRA_VARS_FILE}"

cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local
EOF

log "running ansible-playbook upgrade.yml (vmid=${VMID} -> ${TO_VERSION})"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    upgrade.yml

log "upgrade complete"
