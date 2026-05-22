#!/usr/bin/env bash
# delete-instance.sh — tear down a previously-provisioned DHIS2
# instance. Runs Phase 5 (remove central nginx vhost via
# configure-host-proxy.sh --remove) and Phase 1/3 (Ansible: destroy LXC
# and optionally drop a remote PostgreSQL database).
#
# Phase headers ("PLAY [Phase N — ...]") are written verbatim so the
# Backstage activity-log classifier groups the output into the same
# Nginx / Proxmox / PostgreSQL sections as Create Instance.
#
# All secrets come from env vars (or --vars-file), never argv.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: delete-instance.sh [options]

Required:
  --vmid <int>              Proxmox VMID to destroy
  --node <name>             Proxmox node name
    --domain <fqdn[/segment]> Same form used by create-instance.sh

Optional (central Nginx):
  --proxy-host <host>       SSH target running the central Nginx
                            (default: --node value over SSH)
  --proxy-port <int>        SSH port for --proxy-host (default: 22)
  --proxy-user <name>       SSH user for --proxy-host (default: root)
  --proxy-ssh-key <path>    SSH private key for --proxy-host
  --proxy-nginx-dir <dir>   Per-instance upstream snippet dir
                            (default: /etc/nginx/upstream)
  --proxy-nginx-reload <cmd>
                            Command run after vhost removal
                            (default: nginx -s reload, applied by
                            configure-host-proxy.sh)
  --skip-proxy-cleanup      Don't touch nginx (instance retained at LB)

Optional (shared PostgreSQL host):
  --db-host <host>          Remote PostgreSQL host (drops DB+role here)
  --db-port <int>           Remote PostgreSQL port (default: 5432)
  --db-name <name>          Database name to drop
  --db-user <name>          Per-instance role to drop
  --drop-database           Actually drop the DB+role (otherwise skipped)

Lifecycle:
  --ssh-key <path>          Orchestrator SSH key (forwarded to ansible)
  --keep-vars-file          Don't delete the rendered vars.yml on exit
  -h | --help               Show this help

Required env vars (Proxmox REST API credentials):
  PROXMOX_API_URL           e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS validation (default: false)

Optional env vars (shared PostgreSQL admin credentials):
  DHIS2_DB_ADMIN_USER       (default: postgres)
  DHIS2_DB_ADMIN_PASS       Password for the admin user
EOF
}

VMID=""
NODE=""
DOMAIN=""
PROXY_HOST=""
PROXY_PORT="22"
PROXY_USER="root"
PROXY_SSH_KEY=""
PROXY_NGINX_DIR=""
PROXY_NGINX_RELOAD=""
SKIP_PROXY_CLEANUP=0
DB_HOST=""
DB_PORT="5432"
DB_NAME=""
DB_USER=""
DROP_DATABASE=0
SSH_KEY=""
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --proxy-host) PROXY_HOST="$2"; shift 2;;
        --proxy-port) PROXY_PORT="$2"; shift 2;;
        --proxy-user) PROXY_USER="$2"; shift 2;;
        --proxy-ssh-key) PROXY_SSH_KEY="$2"; shift 2;;
        --proxy-nginx-dir) PROXY_NGINX_DIR="$2"; shift 2;;
        --proxy-nginx-reload) PROXY_NGINX_RELOAD="$2"; shift 2;;
        --skip-proxy-cleanup) SKIP_PROXY_CLEANUP=1; shift;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --drop-database) DROP_DATABASE=1; shift;;
        --ssh-key) SSH_KEY="$2"; shift 2;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

for k in VMID NODE DOMAIN; do
    if [[ -z "${!k}" ]]; then
        echo "Missing required --${k,,}" >&2
        exit 2
    fi
done

: "${PROXMOX_API_URL:?missing PROXMOX_API_URL}"
: "${PROXMOX_USER:?missing PROXMOX_USER}"
: "${PROXMOX_TOKEN_ID:?missing PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?missing PROXMOX_TOKEN_SECRET}"
PROXMOX_VALIDATE_CERTS="${PROXMOX_VALIDATE_CERTS:-false}"

# Strip a leading "user@realm!" prefix from PROXMOX_TOKEN_ID if present —
# same defence as create-instance.sh.
if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    echo "[decommission] stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}" >&2
    unset _orig_token_id
fi

# Match create-instance.sh: use the orchestrator venv so localhost plays
# can import proxmoxer/community.general without depending on system Python.
if [[ -z "${ANSIBLE_PYTHON_INTERPRETER:-}" \
      && -x "/opt/backstage/venv/bin/python3" ]]; then
    export ANSIBLE_PYTHON_INTERPRETER="/opt/backstage/venv/bin/python3"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[decommission] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-decommission-${VMID}-XXXXXX")"
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

# ----------------------------------------------------------------------------
# Phase 5 — remove central Nginx vhost via configure-host-proxy.sh --remove
# ----------------------------------------------------------------------------
# Run before destroying the LXC so users stop getting routed to it.
# Header is printed in the same format ansible uses ("PLAY [Phase N — ...]"),
# which the Backstage log classifier already groups under "Nginx".
printf '\nPLAY [Phase 5 — remove central Nginx vhost] *********\n\n'

if [[ "${SKIP_PROXY_CLEANUP}" == "1" ]]; then
    log "--skip-proxy-cleanup set, leaving nginx config in place"
else
    PROXY_ARGS=(--remove --vmid "${VMID}" --domain "${DOMAIN}")
    # When the operator hasn't supplied a --proxy-host, configure-host-proxy.sh
    # runs locally on whichever host this script was invoked from. The
    # provision side defaults to the PVE host, so mirror that.
    EFFECTIVE_PROXY_HOST="${PROXY_HOST}"
    if [[ -z "${EFFECTIVE_PROXY_HOST}" ]]; then
        # Best-effort: parse host:port out of PROXMOX_API_URL
        _pve_host="${PROXMOX_API_URL#*://}"
        _pve_host="${_pve_host%%:*}"
        _pve_host="${_pve_host%%/*}"
        EFFECTIVE_PROXY_HOST="${_pve_host}"
    fi
    if [[ -n "${EFFECTIVE_PROXY_HOST}" && "${EFFECTIVE_PROXY_HOST}" != "localhost" \
          && "${EFFECTIVE_PROXY_HOST}" != "127.0.0.1" ]]; then
        PROXY_ARGS+=(--pve-host "${EFFECTIVE_PROXY_HOST}"
                     --pve-user "${PROXY_USER}")
        if [[ -n "${PROXY_SSH_KEY}" ]]; then
            PROXY_ARGS+=(--pve-ssh-key "${PROXY_SSH_KEY}")
        elif [[ -n "${SSH_KEY}" ]]; then
            PROXY_ARGS+=(--pve-ssh-key "${SSH_KEY}")
        fi
    fi
    if [[ -n "${PROXY_NGINX_DIR}" ]]; then
        PROXY_ARGS+=(--upstream-dir "${PROXY_NGINX_DIR}")
    fi
    log "running: configure-host-proxy.sh ${PROXY_ARGS[*]}"
    # Tolerate failures — leaving a stale nginx upstream file is recoverable
    # (the playbook will report the LXC destroy separately) and we still want
    # to attempt the LXC + DB cleanup so the operator can re-run on the
    # nginx side later.
    "${SCRIPT_DIR}/configure-host-proxy.sh" "${PROXY_ARGS[@]}" || \
        log "WARN: configure-host-proxy.sh --remove exited non-zero; continuing"
fi

# ----------------------------------------------------------------------------
# Render extra-vars for the ansible playbook (Phase 1 + Phase 3)
# ----------------------------------------------------------------------------
log "rendering extra-vars at ${EXTRA_VARS_FILE}"

# Strip scheme/port from PROXMOX_API_URL → bare host for the proxmox module.
_pve_api_host="${PROXMOX_API_URL#*://}"
_pve_api_host="${_pve_api_host%%/*}"
_pve_api_host="${_pve_api_host%%:*}"

cat > "${EXTRA_VARS_FILE}" <<EOF
---
pve_api_host: "${_pve_api_host}"
pve_api_user: "${PROXMOX_USER}"
pve_api_token_id: "${PROXMOX_TOKEN_ID}"
pve_api_token_secret: "${PROXMOX_TOKEN_SECRET}"
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS}
pve_node: "${NODE}"
pve_vmid: ${VMID}
fqdn: "${DOMAIN}"
dhis2_db_host: "${DB_HOST}"
dhis2_db_port: ${DB_PORT}
dhis2_db_name: "${DB_NAME}"
dhis2_db_user: "${DB_USER}"
dhis2_db_admin_user: "${DHIS2_DB_ADMIN_USER:-postgres}"
dhis2_db_admin_password: "${DHIS2_DB_ADMIN_PASS:-}"
dhis2_db_drop: $([[ "${DROP_DATABASE}" == "1" ]] && echo true || echo false)
EOF
chmod 0600 "${EXTRA_VARS_FILE}"

# Minimal inventory — playbook only uses hosts: localhost.
cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local ansible_python_interpreter=${ANSIBLE_PYTHON_INTERPRETER:-/usr/bin/python3}
EOF

# ----------------------------------------------------------------------------
# Run the ansible decommission playbook
# ----------------------------------------------------------------------------
log "running ansible-playbook delete.yml"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    delete.yml

log "decommission complete"
