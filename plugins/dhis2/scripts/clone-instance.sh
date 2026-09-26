#!/usr/bin/env bash
# clone-instance.sh — duplicate an existing DHIS2 instance into a new
# LXC and reconfigure DB + nginx vhost for the target environment.
# Mirrors the wrapper pattern of create-instance.sh / update-instance.sh.
#
# All secrets come from env vars, never argv.

set -euo pipefail
umask 077

usage() {
    cat <<'EOF'
Usage: clone-instance.sh [options]

Source (existing instance):
  --src-vmid <int>          Source LXC VMID
  --src-node <name>         Proxmox node hosting the source LXC
  --src-hostname <name>     Source container hostname (for log lines)
  --src-db-name <name>      Source DHIS2 database name (shared-* strategies)

Target (new instance):
  --vmid <int>              Target VMID for the clone
  --node <name>             Proxmox node to place the clone on
  --hostname <name>         Container hostname for the clone
  --ip <addr>               Static IPv4 for the container (from IPAM allocation); DHCP if omitted
  --ip-prefix <n>           Prefix length for --ip (default 24)
  --gateway <addr>          Gateway for --ip (required with --ip)
  --instance-name <name>    Backstage display name (registered in inventory)
  --domain <fqdn[/segment]> Public FQDN/segment for the clone
  --cpu <int>               Target vCPU count
  --memory <mb>             Target memory in megabytes
  --storage <gb>            Target rootfs size in gigabytes (grow only)
  --version <label>         DHIS2 version label (registry only)

Database strategy + credentials:
  --db-strategy <colocated|shared-clone|shared-keep>
  --db-host <host>          Final DB host rendered into dhis.conf
  --db-port <int>           Final DB port (default 5432)
  --db-name <name>          Final DB name rendered into dhis.conf
  --db-user <name>          Final DB user rendered into dhis.conf

Lifecycle:
  --pause-source            Briefly shutdown source LXC for a consistent clone (default)
  --no-pause-source         Clone live source (may produce an inconsistent copy)
  --shutdown-timeout <sec>  Graceful shutdown timeout (default 60)
  --no-restart-tomcat       Render dhis.conf but skip the Tomcat restart

Proxy (optional — defaults to PVE host derived from PROXMOX_API_URL):
  --pve-host <host>         SSH target for `pct push/exec` (defaults to PVE)
  --pve-port <int>          SSH port (default 22)
  --pve-user <name>         SSH user (default root)
  --pve-ssh-key <path>      SSH private key for the PVE host
  --proxy-host <host>       Central nginx host (defaults to --pve-host)
  --proxy-port <int>        Proxy SSH port (default 22)
  --proxy-user <name>       Proxy SSH user (default root)
  --proxy-ssh-key <path>    Proxy SSH private key
  --proxy-upstream-dir <p>  Override host_proxy_upstream_dir
  --proxy-nginx-reload <c>  Override host_proxy_nginx_reload_cmd
  --skip-certbot            Don't request a Let's Encrypt cert
  --email <addr>            Contact email for Let's Encrypt
  --keep-vars-file          Don't delete the rendered vars.yml on exit
  -h | --help               Show this help

Required env vars (Proxmox REST API credentials):
  PROXMOX_API_URL           e.g. https://pve01:8006
  PROXMOX_USER              e.g. root@pam
  PROXMOX_TOKEN_ID          API token id (the part AFTER the `!`)
  PROXMOX_TOKEN_SECRET      API token secret
  PROXMOX_VALIDATE_CERTS    "true" to enforce TLS validation (default: false)

Required env vars (DHIS2 database password for clone):
  DHIS2_DB_PASS             Password for the new per-instance DB role

Required env vars when --db-strategy=shared-clone (admin role on shared PG):
  DHIS2_DB_ADMIN_USER       Default: postgres
  DHIS2_DB_ADMIN_PASS       Admin role password
EOF
}

SRC_VMID=""
SRC_NODE=""
SRC_HOSTNAME=""
SRC_DB_NAME=""
VMID=""
NODE=""
HOSTNAME_=""
INSTANCE_NAME=""
DOMAIN=""
CPU=""
MEMORY=""
STORAGE=""
VERSION=""
DB_STRATEGY=""
DB_HOST=""
DB_PORT="5432"
DB_NAME=""
DB_USER=""
PAUSE_SOURCE=1
SHUTDOWN_TIMEOUT="60"
RESTART_TOMCAT=1
TOMCAT_VERSION=""
PVE_HOST=""
PVE_PORT="22"
PVE_USER="root"
PVE_SSH_KEY=""
PROXY_HOST=""
PROXY_PORT=""
PROXY_USER=""
PROXY_SSH_KEY=""
PROXY_UPSTREAM_DIR=""
PROXY_NGINX_RELOAD=""
SKIP_CERTBOT=0
EMAIL=""
KEEP_VARS_FILE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --src-vmid) SRC_VMID="$2"; shift 2;;
        --src-node) SRC_NODE="$2"; shift 2;;
        --src-hostname) SRC_HOSTNAME="$2"; shift 2;;
        --src-db-name) SRC_DB_NAME="$2"; shift 2;;
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --hostname) HOSTNAME_="$2"; shift 2;;
        --instance-name) INSTANCE_NAME="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --cpu) CPU="$2"; shift 2;;
        --memory) MEMORY="$2"; shift 2;;
        --storage) STORAGE="$2"; shift 2;;
        --version) VERSION="$2"; shift 2;;
        --db-strategy) DB_STRATEGY="$2"; shift 2;;
        --db-host) DB_HOST="$2"; shift 2;;
        --db-port) DB_PORT="$2"; shift 2;;
        --db-name) DB_NAME="$2"; shift 2;;
        --db-user) DB_USER="$2"; shift 2;;
        --pause-source) PAUSE_SOURCE=1; shift;;
        --no-pause-source) PAUSE_SOURCE=0; shift;;
        --shutdown-timeout) SHUTDOWN_TIMEOUT="$2"; shift 2;;
        --no-restart-tomcat) RESTART_TOMCAT=0; shift;;
        --tomcat-version) TOMCAT_VERSION="$2"; shift 2;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-port) PVE_PORT="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        --proxy-host) PROXY_HOST="$2"; shift 2;;
        --proxy-port) PROXY_PORT="$2"; shift 2;;
        --proxy-user) PROXY_USER="$2"; shift 2;;
        --proxy-ssh-key) PROXY_SSH_KEY="$2"; shift 2;;
        --proxy-upstream-dir) PROXY_UPSTREAM_DIR="$2"; shift 2;;
        --proxy-nginx-reload) PROXY_NGINX_RELOAD="$2"; shift 2;;
        --skip-certbot) SKIP_CERTBOT=1; shift;;
        --email) EMAIL="$2"; shift 2;;
        --keep-vars-file) KEEP_VARS_FILE=1; shift;;
        --ip) STATIC_IP="$2"; shift 2;;
        --ip-prefix) STATIC_PREFIX="$2"; shift 2;;
        --gateway) STATIC_GATEWAY="$2"; shift 2;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

# Optional static IPv4 from IPAM allocation (DHCP when --ip is omitted).
STATIC_IP="${STATIC_IP:-}"
STATIC_PREFIX="${STATIC_PREFIX:-24}"
STATIC_GATEWAY="${STATIC_GATEWAY:-}"
if [[ -n "${STATIC_IP}" ]]; then
    ipv4='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
    [[ "${STATIC_IP}" =~ ${ipv4} ]] || { echo "--ip must be an IPv4 address" >&2; exit 2; }
    [[ "${STATIC_GATEWAY}" =~ ${ipv4} ]] || { echo "--gateway is required with --ip" >&2; exit 2; }
    [[ "${STATIC_PREFIX}" =~ ^[0-9]{1,2}$ ]] || { echo "--ip-prefix must be a number" >&2; exit 2; }
fi

for k in SRC_VMID SRC_NODE VMID NODE HOSTNAME_ INSTANCE_NAME DOMAIN \
         CPU MEMORY STORAGE DB_STRATEGY DB_HOST DB_NAME DB_USER; do
    if [[ -z "${!k}" ]]; then
        echo "Missing required --${k,,}" >&2
        exit 2
    fi
done

case "${DB_STRATEGY}" in
    colocated|shared-clone|shared-keep) ;;
    *) echo "--db-strategy must be one of: colocated, shared-clone, shared-keep" >&2; exit 2;;
esac

if [[ -n "${TOMCAT_VERSION}" ]]; then
    case "${TOMCAT_VERSION}" in
        9|10) ;;
        *)
            echo "invalid --tomcat-version '${TOMCAT_VERSION}' (expected 9 or 10)" >&2
            exit 2
            ;;
    esac
fi

: "${PROXMOX_API_URL:?missing PROXMOX_API_URL}"
: "${PROXMOX_USER:?missing PROXMOX_USER}"
: "${PROXMOX_TOKEN_ID:?missing PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?missing PROXMOX_TOKEN_SECRET}"
: "${DHIS2_DB_PASS:?missing DHIS2_DB_PASS}"
PROXMOX_VALIDATE_CERTS="${PROXMOX_VALIDATE_CERTS:-false}"

if [[ "${DB_STRATEGY}" == "shared-clone" ]]; then
    : "${DHIS2_DB_ADMIN_PASS:?missing DHIS2_DB_ADMIN_PASS (required for --db-strategy shared-clone)}"
fi
DHIS2_DB_ADMIN_USER="${DHIS2_DB_ADMIN_USER:-postgres}"
DHIS2_DB_ADMIN_PASS="${DHIS2_DB_ADMIN_PASS:-}"

# Strip a leading "user@realm!" prefix from PROXMOX_TOKEN_ID if present.
if [[ "${PROXMOX_TOKEN_ID}" == *"!"* ]]; then
    _orig_token_id="${PROXMOX_TOKEN_ID}"
    PROXMOX_TOKEN_ID="${PROXMOX_TOKEN_ID##*!}"
    echo "[clone] stripped user prefix from PROXMOX_TOKEN_ID: ${_orig_token_id} -> ${PROXMOX_TOKEN_ID}" >&2
    unset _orig_token_id
fi

_pve_api_host_port="${PROXMOX_API_URL#*://}"
_pve_api_host_port="${_pve_api_host_port%%/*}"
_pve_api_host_only="${_pve_api_host_port%%:*}"
PVE_HOST="${PVE_HOST:-${_pve_api_host_only}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "${SCRIPT_DIR}/../ansible" && pwd)"

log() { printf '[clone] %s\n' "$*" >&2; }

WORK_DIR="$(mktemp -d -t "dhis2-clone-${VMID}-XXXXXX")"
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

SERVER_BASE_URL="https://${DOMAIN}"

yaml_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "${s}"
}

log "rendering extra-vars at ${EXTRA_VARS_FILE}"

cat > "${EXTRA_VARS_FILE}" <<EOF
---
# Rendered by clone-instance.sh — do not edit by hand.

# ---- Proxmox API ----
pve_api_host: $(yaml_escape "${_pve_api_host_port}")
pve_api_user: $(yaml_escape "${PROXMOX_USER}")
pve_api_token_id: $(yaml_escape "${PROXMOX_TOKEN_ID}")
pve_api_token_secret: $(yaml_escape "${PROXMOX_TOKEN_SECRET}")
pve_validate_certs: ${PROXMOX_VALIDATE_CERTS:-false}

# ---- Source ----
src_node: $(yaml_escape "${SRC_NODE}")
src_vmid: ${SRC_VMID}
src_hostname: $(yaml_escape "${SRC_HOSTNAME}")
src_db_host: $(yaml_escape "${DB_HOST}")
src_db_port: ${DB_PORT}
src_db_name: $(yaml_escape "${SRC_DB_NAME}")

# ---- Target identity / resources ----
pve_node: $(yaml_escape "${NODE}")
pve_vmid: ${VMID}
pve_hostname: $(yaml_escape "${HOSTNAME_}")
$( [[ -n "${STATIC_IP}" ]] && printf 'pve_static_ip: %s\npve_static_prefix: %s\npve_static_gateway: %s\n' "$(yaml_escape "${STATIC_IP}")" "${STATIC_PREFIX}" "$(yaml_escape "${STATIC_GATEWAY}")" )
instance_name: $(yaml_escape "${INSTANCE_NAME}")
fqdn: $(yaml_escape "${DOMAIN}")
dhis2_cores: ${CPU}
dhis2_memory_mb: ${MEMORY}
dhis2_storage_gb: ${STORAGE}
dhis2_version: $(yaml_escape "${VERSION}")

# ---- SSH for pct push/exec on the PVE host ----
pve_ssh_host: $(yaml_escape "${PVE_HOST}")
pve_ssh_port: ${PVE_PORT}
pve_ssh_user: $(yaml_escape "${PVE_USER}")
pve_ssh_key: $(yaml_escape "${PVE_SSH_KEY}")

# ---- DB strategy + final connection rendered into dhis.conf ----
dhis2_clone_db_strategy: $(yaml_escape "${DB_STRATEGY}")
dhis2_db_host: $(yaml_escape "${DB_HOST}")
dhis2_db_port: ${DB_PORT}
dhis2_db_name: $(yaml_escape "${DB_NAME}")
dhis2_db_user: $(yaml_escape "${DB_USER}")
dhis2_db_password: $(yaml_escape "${DHIS2_DB_PASS}")
dhis2_db_admin_user: $(yaml_escape "${DHIS2_DB_ADMIN_USER}")
dhis2_db_admin_password: $(yaml_escape "${DHIS2_DB_ADMIN_PASS}")
dhis2_server_base_url: $(yaml_escape "${SERVER_BASE_URL}")

# ---- Lifecycle ----
clone_pause_source: $([[ "${PAUSE_SOURCE}" == "1" ]] && echo true || echo false)
clone_shutdown_timeout: ${SHUTDOWN_TIMEOUT}
restart_tomcat: $([[ "${RESTART_TOMCAT}" == "1" ]] && echo true || echo false)
$([[ -n "${TOMCAT_VERSION}" ]] && printf 'tomcat_version: "%s"\n' "${TOMCAT_VERSION}")

# ---- Proxy (Phase 7) ----
proxy_ssh_host: $(yaml_escape "${PROXY_HOST:-${PVE_HOST}}")
proxy_ssh_port: ${PROXY_PORT:-${PVE_PORT}}
proxy_ssh_user: $(yaml_escape "${PROXY_USER:-${PVE_USER}}")
proxy_ssh_key: $(yaml_escape "${PROXY_SSH_KEY:-${PVE_SSH_KEY}}")
host_proxy_upstream_dir: $(yaml_escape "${PROXY_UPSTREAM_DIR}")
host_proxy_nginx_reload_cmd: $(yaml_escape "${PROXY_NGINX_RELOAD}")
host_proxy_skip_certbot: $([[ "${SKIP_CERTBOT}" == "1" ]] && echo true || echo false)
email: $(yaml_escape "${EMAIL}")
EOF
chmod 0600 "${EXTRA_VARS_FILE}"

cat > "${INVENTORY_FILE}" <<EOF
[local]
localhost ansible_connection=local
EOF

log "running ansible-playbook clone.yml (src=${SRC_VMID}@${SRC_NODE} -> ${VMID}@${NODE}, db=${DB_STRATEGY})"
ANSIBLE_EXTRA_ARGS=()
if [[ "${DHIS2_DEBUG:-0}" == "1" || "${DHIS2_DEBUG:-}" == "true" ]]; then
    ANSIBLE_EXTRA_ARGS+=(-v)
fi

cd "${ANSIBLE_DIR}"
ansible-playbook \
    -i "${INVENTORY_FILE}" \
    --extra-vars "@${EXTRA_VARS_FILE}" \
    "${ANSIBLE_EXTRA_ARGS[@]}" \
    clone.yml

log "clone complete"
