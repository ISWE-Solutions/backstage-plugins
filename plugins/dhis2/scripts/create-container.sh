#!/usr/bin/env bash
# create-container.sh — Proxmox-native LXC creation + SSH bootstrap.
#
# Responsibilities (intentionally narrow):
#   1. Create an unprivileged LXC container on the given Proxmox node.
#   2. Start it and wait for the network to come up.
#   3. Install openssh-server + python3 + sudo (Ansible's minimum runtime).
#   4. Create a non-root `ansible` user with NOPASSWD sudo.
#   5. Inject the orchestrator's SSH public key into authorized_keys.
#   6. Print the container IPv4 address to stdout (and optionally to a file).
#
# Everything else (Postgres, Tomcat, DHIS2, dhis.conf) is handled by Ansible —
# see ../ansible/site.yml.
#
# Inputs are passed as flags (not positional). Secrets come from env vars.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: create-container.sh [options]

Required:
  --vmid <int>              Proxmox VMID
  --node <name>             Proxmox node name
  --hostname <name>         Container hostname
  --ssh-pubkey <path>       Path to the orchestrator's SSH public key

Optional:
  --cpu <int>               CPU cores (default: 4)
  --memory <mb>             RAM in MB (default: 8192)
  --storage <gb>            Root disk in GB (default: 100)
  --storage-pool <name>     Storage pool (default: local-lvm)
  --bridge <name>           Network bridge (default: vmbr0)
  --template <path>         OS template (default: Ubuntu 22.04)
  --ansible-user <name>     Username Ansible will SSH in as (default: ansible)
  --ip-out-file <path>      Write the container's IPv4 address to this file
  --rollback-on-failure     pct destroy the container if any step fails
  --pve-host <host>         Run Proxmox CLI (pct/pvesh) on this host over
                            SSH instead of locally. Default: localhost.
  --pve-user <user>         SSH user for --pve-host (default: root)
  --pve-ssh-key <path>      SSH private key for --pve-host (default: env
                            $PVE_SSH_KEY or none)
  -h | --help               Show this help

The container's root password is read from the ROOT_PASSWORD env var so it
never appears in `ps`/shell-history. It is only used for emergency console
access; SSH key auth is the normal path.
EOF
}

# Defaults
CPU=4
MEMORY=8192
STORAGE=100
STORAGE_POOL="local-lvm"
BRIDGE="vmbr0"
TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
ANSIBLE_USER="ansible"
IP_OUT_FILE=""
ROLLBACK_ON_FAILURE=0

VMID=""; NODE=""; HOSTNAME=""; SSH_PUBKEY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --node) NODE="$2"; shift 2;;
        --hostname) HOSTNAME="$2"; shift 2;;
        --ssh-pubkey) SSH_PUBKEY="$2"; shift 2;;
        --cpu) CPU="$2"; shift 2;;
        --memory) MEMORY="$2"; shift 2;;
        --storage) STORAGE="$2"; shift 2;;
        --storage-pool) STORAGE_POOL="$2"; shift 2;;
        --bridge) BRIDGE="$2"; shift 2;;
        --template) TEMPLATE="$2"; shift 2;;
        --ansible-user) ANSIBLE_USER="$2"; shift 2;;
        --ip-out-file) IP_OUT_FILE="$2"; shift 2;;
        --rollback-on-failure) ROLLBACK_ON_FAILURE=1; shift;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

# Source PVE helper functions (pct / pvesh become SSH-aware shims).
SCRIPT_DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# shellcheck source=./_pve_helpers.sh
source "${SCRIPT_DIR_SELF}/_pve_helpers.sh"

for var in VMID NODE HOSTNAME SSH_PUBKEY; do
    if [[ -z "${!var}" ]]; then
        echo "missing required flag for ${var}" >&2
        usage >&2
        exit 2
    fi
done
[[ -r "${SSH_PUBKEY}" ]] || { echo "ssh pubkey not readable: ${SSH_PUBKEY}" >&2; exit 2; }
[[ -n "${ROOT_PASSWORD:-}" ]] || { echo "ROOT_PASSWORD env var must be set" >&2; exit 2; }

log() { printf '[create-container] %s\n' "$*" >&2; }

cleanup_on_failure() {
    local rc=$?
    if [[ ${rc} -ne 0 && ${ROLLBACK_ON_FAILURE} -eq 1 ]]; then
        log "FAILED (rc=${rc}) — rolling back container ${VMID}"
        pct stop "${VMID}" 2>/dev/null || true
        pct destroy "${VMID}" --purge 2>/dev/null || true
    fi
    return ${rc}
}
trap cleanup_on_failure EXIT

log "creating LXC ${VMID} on node ${NODE}"
pvesh create "/nodes/${NODE}/lxc" \
    --vmid "${VMID}" \
    --hostname "${HOSTNAME}" \
    --ostemplate "${TEMPLATE}" \
    --memory "${MEMORY}" \
    --cores "${CPU}" \
    --rootfs "${STORAGE_POOL}:${STORAGE}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
    --nameserver 8.8.8.8 \
    --features nesting=1 \
    --unprivileged 1 \
    --password "${ROOT_PASSWORD}"

log "starting container ${VMID}"
pct start "${VMID}"

log "waiting for container network"
CONTAINER_IP=""
for _ in $(seq 1 30); do
    CONTAINER_IP="$(pct exec "${VMID}" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" || true)"
    if [[ -n "${CONTAINER_IP}" && "${CONTAINER_IP}" != "127.0.0.1" ]]; then
        break
    fi
    sleep 2
done
if [[ -z "${CONTAINER_IP}" ]]; then
    echo "container ${VMID} never got an IPv4 address" >&2
    exit 1
fi
log "container IP: ${CONTAINER_IP}"

# Install openssh + python + create the ansible user. One pct-exec, no
# nested quoting of secrets/keys (the pubkey is pushed separately below).
log "installing openssh + python + creating ${ANSIBLE_USER} user"
pct exec "${VMID}" -- env DEBIAN_FRONTEND=noninteractive ANSIBLE_USER="${ANSIBLE_USER}" bash -s <<'BOOTSTRAP'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq openssh-server python3 python3-apt sudo ca-certificates

sed -i \
    -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
    -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
    -e 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
    /etc/ssh/sshd_config

if ! id -u "${ANSIBLE_USER}" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "${ANSIBLE_USER}"
fi
install -d -m 0700 -o "${ANSIBLE_USER}" -g "${ANSIBLE_USER}" "/home/${ANSIBLE_USER}/.ssh"

printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${ANSIBLE_USER}" > "/etc/sudoers.d/90-${ANSIBLE_USER}"
chmod 0440 "/etc/sudoers.d/90-${ANSIBLE_USER}"
visudo -cf "/etc/sudoers.d/90-${ANSIBLE_USER}"

systemctl enable --now ssh
systemctl restart ssh
BOOTSTRAP

log "injecting SSH public key for ${ANSIBLE_USER}"
pct_push_local "${VMID}" "${SSH_PUBKEY}" "/home/${ANSIBLE_USER}/.ssh/authorized_keys"
pct exec "${VMID}" -- chown "${ANSIBLE_USER}:${ANSIBLE_USER}" "/home/${ANSIBLE_USER}/.ssh/authorized_keys"
pct exec "${VMID}" -- chmod 0600 "/home/${ANSIBLE_USER}/.ssh/authorized_keys"

# stdout is the IP only; logs go to stderr (see `log`). Lets callers do
# CONTAINER_IP="$(create-container.sh ...)" cleanly.
if [[ -n "${IP_OUT_FILE}" ]]; then
    printf '%s\n' "${CONTAINER_IP}" > "${IP_OUT_FILE}"
fi
printf '%s\n' "${CONTAINER_IP}"

log "container ${VMID} ready for Ansible at ${ANSIBLE_USER}@${CONTAINER_IP}"
