#!/usr/bin/env bash
# update-instance.sh — apply post-provision changes to an existing DHIS2
# instance using ansible (update.yml). Mirrors the wrapper pattern of
# create-instance.sh / delete-instance.sh: renders an
# extra-vars file, drops a minimal inventory, and execs ansible-playbook
# so the activity-log dialog in the Backstage UI sees the same
# "PLAY [Phase N — ...]" headers it already classifies for Create.
#
# All secrets come from env vars, never argv.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: update-instance.sh [options]

Required:
  --vmid <int>              Proxmox VMID of the instance to edit
  --node <name>             Proxmox node hosting the LXC
    --domain <fqdn[/segment]> Same form used by create-instance.sh
  --cpu <int>               Target vCPU count
  --memory <mb>             Target memory in megabytes
  --storage <gb>            Target rootfs size in gigabytes (grow only)
  --db-name <name>          DHIS2 database name (rendered into dhis.conf)
  --db-user <name>          DHIS2 database role (rendered into dhis.conf)

Optional:
  --db-host <host>          Remote PostgreSQL host (default: localhost
                            => the LXC's own postgres)
  --db-port <int>           PostgreSQL port (default: 5432)
  --pve-host <host>         SSH target running `pct` (default: derived
                            from PROXMOX_API_URL)
  --pve-port <int>          SSH port for --pve-host (default: 22)
  --pve-user <name>         SSH user for --pve-host (default: root)
  --pve-ssh-key <path>      SSH private key for --pve-host
  --no-restart-tomcat       Render dhis.conf but skip the Tomcat restart
  --keep-vars-file          Don't delete the rendered vars.yml on exit
  -h | --help               Show this help

Required env vars (Proxmox REST API credentials):
  PROXMOX_API_URL           e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (the part AFTER the `!`)
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS validation (default: false)

Required env vars (DHIS2 database password):
  DHIS2_DB_PASS             Password for the per-instance DB role
EOF
}

VMID=""
NODE=""
DOMAIN=""
CPU=""
MEMORY=""
STORAGE=""
DB_NAME=""
DB_USER=""
DB_HOST=""
DB_PORT="5432"
PVE_HOST=""
PVE_PORT="22"
PVE_USER="root"
PVE_SSH_KEY=""
RESTART_TOMCAT=1
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --cpu) CPU="$2"; shift 2;;
        --memory) MEMORY="$2"; shift 2;;
        --storage) STORAGE="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-port) PVE_PORT="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        --no-restart-tomcat) RESTART_TOMCAT=0; shift;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

for k in VMID NODE DOMAIN CPU MEMORY STORAGE DB_NAME DB_USER; do
    if [[ -z "${!k}" ]]; then
        echo "Missing required --${k,,}" >&2
        exit 2
    fi
done

: "${PROXMOX_API_URL:?missing PROXMOX_API_URL}"
: "${PROXMOX_USER:?missing PROXMOX_USER}"
: "${PROXMOX_TOKEN_ID:?missing PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?missing PROXMOX_TOKEN_SECRET}"
: "${DHIS2_DB_PASS:?missing DHIS2_DB_PASS}"
PROXMOX_VALIDATE_CERTS="${PROXMOX_VALIDATE_CERTS:-false}"

# Strip a leading "user@realm!" prefix from PROXMOX_TOKEN_ID if present —
# same defence as create-instance.sh / delete-instance.sh.
if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    echo "[edit] stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}" >&2
    unset _orig_token_id
fi

# Strip scheme/port from PROXMOX_API_URL → bare "host:port" for proxmox API,
# and a bare "host" for pct-via-SSH defaulting.
_pve_api_host_port="${PROXMOX_API_URL#*://}"
_pve_api_host_port="${_pve_api_host_port%%/*}"
_pve_api_host_only="${_pve_api_host_port%%:*}"
PVE_HOST="${PVE_HOST:-${_pve_api_host_only}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[edit] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-edit-${VMID}-XXXXXX")"
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

# Derive server.base.url from DOMAIN (matches the URL the proxy role
# writes on the central nginx). DOMAIN may include a /<segment> path
# component for path-based routing.
SERVER_BASE_URL="https://${DOMAIN}"

# YAML-escape helper: double-quote and escape backslashes + double quotes.
yaml_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "${s}"
}

log "rendering extra-vars at ${EXTRA_VARS_FILE}"

cat > "${EXTRA_VARS_FILE}" <<EOF
---
# Rendered by update-instance.sh — do not edit by hand.

# ---- Proxmox API (consumed by Phase 1) ----
pve_api_host: $(yaml_escape "${_pve_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Container identity ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}

# ---- SSH to the PVE host (consumed by Phase 2: pct push/exec) ----
pve_ssh_host: $(yaml_escape "${PVE_HOST}")
pve_ssh_port: ${PVE_PORT}
pve_ssh_user: $(yaml_escape "${PVE_USER}")
pve_ssh_key: $(yaml_escape "${PVE_SSH_KEY}")

# ---- Resource targets ----
dhis2_cores: ${CPU}
dhis2_memory_mb: ${MEMORY}
dhis2_storage_gb: ${STORAGE}

# ---- DHIS2 / database (rendered into dhis.conf) ----
dhis2_db_host: $(yaml_escape "${DB_HOST:-localhost}")
dhis2_db_port: ${DB_PORT:-5432}
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${DB_USER}")
dhis2_db_password: $(yaml_escape "${DHIS2_DB_PASS}")
dhis2_server_base_url: $(yaml_escape "${SERVER_BASE_URL}")
restart_tomcat: $([[ "${RESTART_TOMCAT}" == "1" ]] && echo true || echo false)
EOF
chmod 0600 "${EXTRA_VARS_FILE}"

# Minimal inventory — Phase 1 uses localhost, Phase 2 adds the PVE host
# dynamically via add_host.
cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local
EOF

log "running ansible-playbook update.yml (vmid=${VMID} on ${NODE})"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    update.yml

log "edit complete"
