#!/usr/bin/env bash
# lifecycle-instance.sh — start / stop / restart a DHIS2 LXC via the
# Proxmox REST API. Mirrors the wrapper pattern of create-instance.sh /
# update-instance.sh: renders an extra-vars file, drops a minimal
# inventory, and execs ansible-playbook lifecycle.yml so the Backstage
# activity-log dialog sees the same "PLAY [Phase N — ...]" headers.
#
# All secrets come from env vars, never argv.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: lifecycle-instance.sh [options]

Required:
  --vmid <int>              Proxmox VMID of the instance
  --node <name>             Proxmox node hosting the LXC
  --action <start|stop|restart>

Optional:
  --shutdown-timeout <sec>  Seconds to wait for graceful shutdown / reboot
                            before forcing (default: 60)
  --no-force-stop           Do NOT fall back to a forceful stop after the
                            shutdown timeout (only relevant for --action stop)
  --keep-vars-file          Don't delete the rendered vars.yml on exit
  -h | --help               Show this help

Required env vars (Proxmox REST API credentials):
  PROXMOX_API_URL           e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (the part AFTER the `!`)
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS validation (default: false)
EOF
}

VMID=""
NODE=""
ACTION=""
SHUTDOWN_TIMEOUT="60"
FORCE_STOP=1
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --action) ACTION="$2"; shift 2;;
        --shutdown-timeout) SHUTDOWN_TIMEOUT="$2"; shift 2;;
        --no-force-stop) FORCE_STOP=0; shift;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

for k in VMID NODE ACTION; do
    if [[ -z "${!k}" ]]; then
        echo "Missing required --${k,,}" >&2
        exit 2
    fi
done

case "${ACTION}" in
    start|stop|restart) ;;
    *) echo "--action must be one of: start, stop, restart (got '${ACTION}')" >&2; exit 2;;
esac

: "${PROXMOX_API_URL:?missing PROXMOX_API_URL}"
: "${PROXMOX_USER:?missing PROXMOX_USER}"
: "${PROXMOX_TOKEN_ID:?missing PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?missing PROXMOX_TOKEN_SECRET}"
PROXMOX_VALIDATE_CERTS="${PROXMOX_VALIDATE_CERTS:-false}"

# Strip a leading "user@realm!" prefix from PROXMOX_TOKEN_ID if present.
if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    echo "[lifecycle] stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}" >&2
    unset _orig_token_id
fi

# Strip scheme/port from PROXMOX_API_URL → bare "host:port".
_pve_api_host_port="${PROXMOX_API_URL#*://}"
_pve_api_host_port="${_pve_api_host_port%%/*}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[lifecycle] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-lifecycle-${VMID}-XXXXXX")"
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
# Rendered by lifecycle-instance.sh — do not edit by hand.

# ---- Proxmox API ----
pve_api_host: $(yaml_escape "${_pve_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Container identity ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}

# ---- Lifecycle action ----
dhis2_lifecycle_action: $(yaml_escape "${ACTION}")
dhis2_shutdown_timeout: ${SHUTDOWN_TIMEOUT}
dhis2_force_stop: $([[ "${FORCE_STOP}" == "1" ]] && echo true || echo false)
EOF
chmod 0600 "${EXTRA_VARS_FILE}"

cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local
EOF

log "running ansible-playbook lifecycle.yml (vmid=${VMID} on ${NODE}, action=${ACTION})"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    lifecycle.yml

log "lifecycle ${ACTION} complete"
