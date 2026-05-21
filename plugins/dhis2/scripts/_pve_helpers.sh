# shellcheck shell=bash
# _pve_helpers.sh — sourced by provision-instance.sh / create-container.sh.
#
# Defines shell-function wrappers around the Proxmox CLIs (`pct`, `pvesh`,
# `pvesm`) so the calling script doesn't have to care whether it's running
# on the PVE node directly or driving PVE remotely over SSH from another
# host (typically the Backstage backend).
#
# When the caller sets `PVE_HOST` to a non-local value, all wrapped commands
# are executed on PVE_HOST via `ssh`. When PVE_HOST is empty or local, they
# fall through to the real binaries.
#
# Inputs (all env vars; set them before sourcing this file):
#   PVE_HOST       — hostname of the Proxmox node, or empty/localhost to
#                    run commands locally.
#   PVE_USER       — SSH user on PVE_HOST (default: root).
#   PVE_SSH_KEY    — Path on this host to the SSH private key for PVE_HOST.
#                    Required when PVE_HOST is non-local.
#
# Provided functions (shadow the real binaries via shell function lookup):
#   pct, pvesh, pvesm                 — drop-in remote/local replacements.
#   pct_push_local <vmid> <src> <dst> — copy a file that lives on THIS host
#                                       into the container at <dst>. Handles
#                                       the staging-to-PVE step.
#   pve_run "<cmd line>"              — run an arbitrary command on PVE.

PVE_HOST="${PVE_HOST:-}"
PVE_USER="${PVE_USER:-root}"
PVE_SSH_KEY="${PVE_SSH_KEY:-}"

_pve_is_local() {
    [[ -z "${PVE_HOST}" || "${PVE_HOST}" == "localhost" \
       || "${PVE_HOST}" == "127.0.0.1" || "${PVE_HOST}" == "::1" ]]
}

_pve_ssh_args=(
    -o StrictHostKeyChecking=accept-new
    -o BatchMode=yes
    -o ServerAliveInterval=30
)

_pve_ssh() {
    # Run "$@" on PVE_HOST with shell-safe quoting so single args containing
    # spaces or quotes survive the round-trip through `ssh` (which joins
    # argv with spaces before handing it to the remote shell).
    if _pve_is_local; then
        "$@"
    else
        local key_arg=()
        [[ -n "${PVE_SSH_KEY}" ]] && key_arg=(-i "${PVE_SSH_KEY}")
        local quoted
        quoted="$(printf '%q ' "$@")"
        ssh "${key_arg[@]}" "${_pve_ssh_args[@]}" \
            "${PVE_USER}@${PVE_HOST}" "${quoted}"
    fi
}

pve_run() {
    # Run a single shell command line on PVE.
    if _pve_is_local; then
        bash -c "$1"
    else
        local key_arg=()
        [[ -n "${PVE_SSH_KEY}" ]] && key_arg=(-i "${PVE_SSH_KEY}")
        ssh "${key_arg[@]}" "${_pve_ssh_args[@]}" \
            "${PVE_USER}@${PVE_HOST}" "$1"
    fi
}

pct() {
    # `pct push` needs the source file to live on PVE — special-case below.
    if [[ "${1:-}" == "push" ]]; then
        # Usage: pct push <vmid> <src-on-PVE> <dest-in-container>
        shift
        if _pve_is_local; then
            command pct push "$@"
        else
            _pve_ssh pct push "$@"
        fi
        return $?
    fi
    if _pve_is_local; then
        command pct "$@"
    else
        _pve_ssh pct "$@"
    fi
}

pvesh() {
    if _pve_is_local; then command pvesh "$@"; else _pve_ssh pvesh "$@"; fi
}

pvesm() {
    if _pve_is_local; then command pvesm "$@"; else _pve_ssh pvesm "$@"; fi
}

pct_push_local() {
    # Copy a file from THIS host into a container.
    # Usage: pct_push_local <vmid> <local-src> <dest-in-container>
    local vmid="$1" src="$2" dst="$3"
    if [[ ! -r "${src}" ]]; then
        echo "pct_push_local: source not readable: ${src}" >&2
        return 2
    fi
    if _pve_is_local; then
        command pct push "${vmid}" "${src}" "${dst}"
        return $?
    fi
    # Stage to a temp file on PVE, then have PVE push it into the container.
    local remote_tmp
    remote_tmp="$(pve_run 'mktemp /tmp/dhis2-stage.XXXXXX')"
    [[ -n "${remote_tmp}" ]] || { echo "pct_push_local: mktemp failed on PVE" >&2; return 2; }
    local key_arg=()
    [[ -n "${PVE_SSH_KEY}" ]] && key_arg=(-i "${PVE_SSH_KEY}")
    scp "${key_arg[@]}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        -q "${src}" "${PVE_USER}@${PVE_HOST}:${remote_tmp}"
    pve_run "pct push ${vmid} ${remote_tmp} ${dst} && rm -f ${remote_tmp}"
}

pve_summary() {
    if _pve_is_local; then
        echo "PVE: localhost (running commands directly)"
    else
        echo "PVE: ssh ${PVE_USER}@${PVE_HOST}${PVE_SSH_KEY:+ (key=${PVE_SSH_KEY})}"
    fi
}
