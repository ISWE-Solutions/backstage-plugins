#!/usr/bin/env bash
# configure-host-proxy.sh — central Nginx + Let's Encrypt for one DHIS2 instance.
#
# Runs on the Proxmox host (where the central Nginx terminates TLS and
# reverse-proxies to the per-instance LXC container's Tomcat:8080).
#
# Extracted verbatim-ish from the original create-instance.sh steps 7-8
# but with flag-based args and an unwind path on failure.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: configure-host-proxy.sh [options]

Required:
  --vmid <int>              Proxmox VMID (used in upstream name)
  --container-ip <ip>       IPv4 of the LXC container's Tomcat
  --domain <value>          Either a bare FQDN (subdomain mode) or
                            '<fqdn>/<instance>' (path-based mode). In
                            path-based mode the script writes a base
                            vhost for <fqdn> and a per-instance snippet
                            for <instance> that is included from it.
  --email <addr>            Email for Let's Encrypt notifications

Optional:
  --instance <name>         Override the instance/path segment in path-
                            based mode (default: parsed from --domain).
  --upstream-dir <dir>      Nginx per-instance snippet dir
                            (default: /etc/nginx/upstream). Each
                            instance gets a single <instance>.conf file
                            directly inside this dir (no subfolders).
                            Created if missing.
  --sites-available <dir>   Defaults: /etc/nginx/sites-available in
                            path-based mode, /etc/nginx/conf.d in
                            subdomain mode.
  --sites-enabled <dir>     Defaults: /etc/nginx/sites-enabled in
                            path-based mode, /etc/nginx/conf.d in
                            subdomain mode.
                            (when equal to --sites-available the script
                            skips the sites-enabled symlink because
                            /etc/nginx/conf.d/*.conf is auto-included)
  --skip-certbot            Don't request a Let's Encrypt cert (useful for dev)
  --remove                  Tear down the upstream/site for this --vmid/--domain
                            instead of creating it
  --pve-host <host>         Run this entire script on a remote PVE node over
                            SSH instead of locally. Default: localhost.
  --pve-user <user>         SSH user for --pve-host (default: root)
  --pve-ssh-key <path>      SSH private key for --pve-host
  -h | --help               Show this help
EOF
}

UPSTREAM_DIR="/etc/nginx/upstream"
SITES_AVAILABLE=""
SITES_ENABLED=""
SITES_AVAILABLE_SET=0
SITES_ENABLED_SET=0
SKIP_CERTBOT=0
REMOVE=0
PVE_HOST=""
PVE_USER="root"
PVE_SSH_KEY=""

VMID=""; CONTAINER_IP=""; DOMAIN=""; EMAIL=""; INSTANCE_OVERRIDE=""

# Save argv BEFORE we destructively consume it, so the self-reexec block
# below can forward exactly what we were called with (minus --pve-* flags).
ORIGINAL_ARGS=("$@")

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --container-ip) CONTAINER_IP="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --email) EMAIL="$2"; shift 2;;
        --instance) INSTANCE_OVERRIDE="$2"; shift 2;;
        --upstream-dir) UPSTREAM_DIR="$2"; shift 2;;
        --sites-available) SITES_AVAILABLE="$2"; SITES_AVAILABLE_SET=1; shift 2;;
        --sites-enabled) SITES_ENABLED="$2"; SITES_ENABLED_SET=1; shift 2;;
        --skip-certbot) SKIP_CERTBOT=1; shift;;
        --remove) REMOVE=1; shift;;
        --pve-host) PVE_HOST="$2"; shift 2;;
        --pve-user) PVE_USER="$2"; shift 2;;
        --pve-ssh-key) PVE_SSH_KEY="$2"; shift 2;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

# Self-reexec on the PVE node when --pve-host points elsewhere. The script's
# body is piped in as stdin so we don't need a local copy on PVE. All the
# --pve-* flags are stripped (PVE_HOST=localhost in the child) to prevent an
# infinite loop. The original args (minus --pve-*) are forwarded.
if [[ -n "${PVE_HOST}" && "${PVE_HOST}" != "localhost" \
      && "${PVE_HOST}" != "127.0.0.1" && "${PVE_HOST}" != "::1" ]]; then
    FORWARD_ARGS=()
    i=0
    while [[ $i -lt ${#ORIGINAL_ARGS[@]} ]]; do
        case "${ORIGINAL_ARGS[$i]}" in
            --pve-host|--pve-user|--pve-ssh-key) i=$((i+2));;
            *) FORWARD_ARGS+=("${ORIGINAL_ARGS[$i]}"); i=$((i+1));;
        esac
    done
    KEY_ARG=()
    [[ -n "${PVE_SSH_KEY}" ]] && KEY_ARG=(-i "${PVE_SSH_KEY}")
    exec ssh "${KEY_ARG[@]}" \
        -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        "${PVE_USER}@${PVE_HOST}" \
        "bash -s -- $(printf '%q ' "${FORWARD_ARGS[@]}")" \
        < "${BASH_SOURCE[0]}"
fi

log() { printf '[host-proxy] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Routing mode detection
# ---------------------------------------------------------------------------
# --domain accepts either a bare FQDN ('dhis2.example.org' → subdomain mode,
# one .conf per FQDN) or '<fqdn>/<instance>' ('dhis2.example.org/ento' →
# path-based mode, one shared base vhost for <fqdn> plus per-instance
# include snippets keyed by <instance>). The orchestrator (and the
# Backstage UI's path-based routing mode) constructs the latter form.
if [[ "${DOMAIN}" == */* ]]; then
    ROUTING_MODE="path"
    BASE_DOMAIN="${DOMAIN%%/*}"
    PATH_FROM_DOMAIN="${DOMAIN#*/}"
    # Strip any leading/trailing slashes from the path segment so we end up
    # with a clean filename and location prefix.
    PATH_FROM_DOMAIN="${PATH_FROM_DOMAIN#/}"
    PATH_FROM_DOMAIN="${PATH_FROM_DOMAIN%/}"
    INSTANCE_NAME="${INSTANCE_OVERRIDE:-${PATH_FROM_DOMAIN}}"
    if [[ -z "${BASE_DOMAIN}" || -z "${INSTANCE_NAME}" ]]; then
        echo "--domain '${DOMAIN}' is malformed for path-based mode (need <fqdn>/<instance>)" >&2
        exit 2
    fi
    # Reject filename-hostile characters in <instance> early — otherwise
    # we'd build a snippet path containing '/' or whitespace and the
    # subsequent `cat > ${file}` would fail with 'No such file or directory'.
    if [[ "${INSTANCE_NAME}" =~ [^A-Za-z0-9._-] ]]; then
        echo "--instance / path segment '${INSTANCE_NAME}' contains characters that are not safe in a filename" >&2
        exit 2
    fi
    [[ ${SITES_AVAILABLE_SET} -eq 1 ]] || SITES_AVAILABLE="/etc/nginx/sites-available"
    [[ ${SITES_ENABLED_SET}   -eq 1 ]] || SITES_ENABLED="/etc/nginx/sites-enabled"
else
    ROUTING_MODE="subdomain"
    BASE_DOMAIN="${DOMAIN}"
    INSTANCE_NAME="${INSTANCE_OVERRIDE:-${VMID}}"
    [[ ${SITES_AVAILABLE_SET} -eq 1 ]] || SITES_AVAILABLE="/etc/nginx/conf.d"
    [[ ${SITES_ENABLED_SET}   -eq 1 ]] || SITES_ENABLED="/etc/nginx/conf.d"
fi

if [[ "${ROUTING_MODE}" == "path" ]]; then
    UPSTREAM_FILE="${UPSTREAM_DIR}/${INSTANCE_NAME}.conf"
    SITE_FILE="${SITES_AVAILABLE}/${BASE_DOMAIN}.conf"
    SITE_LINK="${SITES_ENABLED}/${BASE_DOMAIN}.conf"
else
    UPSTREAM_FILE="${UPSTREAM_DIR}/dhis2-${VMID}.conf"
    SITE_FILE="${SITES_AVAILABLE}/dhis2-${BASE_DOMAIN}.conf"
    SITE_LINK="${SITES_ENABLED}/dhis2-${BASE_DOMAIN}.conf"
fi

if [[ ${REMOVE} -eq 1 ]]; then
    [[ -n "${VMID}" && -n "${DOMAIN}" ]] || { echo "--remove needs --vmid and --domain" >&2; exit 2; }
    log "removing nginx config for VMID=${VMID} domain=${DOMAIN} (mode=${ROUTING_MODE})"
    if [[ "${ROUTING_MODE}" == "path" ]]; then
        # In path-based mode the base vhost is shared between every
        # instance under <BASE_DOMAIN>; only drop the per-instance
        # snippet so we don't break sibling instances.
        rm -f "${UPSTREAM_FILE}"
    else
        # When SITES_AVAILABLE == SITES_ENABLED (the conf.d layout)
        # SITE_LINK and SITE_FILE point at the same path; rm -f
        # tolerates that.
        rm -f "${UPSTREAM_FILE}" "${SITE_LINK}" "${SITE_FILE}"
    fi
    nginx -t && systemctl reload nginx
    exit 0
fi

for var in VMID CONTAINER_IP DOMAIN EMAIL; do
    if [[ -z "${!var}" ]]; then
        echo "missing required flag for ${var}" >&2
        usage >&2
        exit 2
    fi
done

# Ensure every directory we're about to write into exists. mkdir -p is
# a no-op when the dir already exists; we additionally log when we have
# to create one so operators can see new layout decisions in the log.
for d in "${UPSTREAM_DIR}" "${SITES_AVAILABLE}" "${SITES_ENABLED}"; do
    if [[ ! -d "${d}" ]]; then
        log "creating missing directory ${d}"
        mkdir -p "${d}"
    fi
done

if [[ "${ROUTING_MODE}" == "path" ]]; then
    # ---- path-based: dhis2.example.org/<instance> ----
    log "writing per-instance snippet ${UPSTREAM_FILE}"
    cat > "${UPSTREAM_FILE}" <<EOF
# Per-instance reverse-proxy snippet for ${BASE_DOMAIN}/${INSTANCE_NAME}
# (VMID=${VMID}). Included from ${SITE_FILE} via:
#     include ${UPSTREAM_DIR}/*.conf;
# inside the TLS server{} block. Drop a new file in ${UPSTREAM_DIR}
# to add another instance — no edits to the base vhost are needed.
location /${INSTANCE_NAME}/ {
    proxy_pass http://${CONTAINER_IP}:8080/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Prefix /${INSTANCE_NAME};
    proxy_set_header Connection "";
    proxy_connect_timeout 300s;
    proxy_send_timeout    300s;
    proxy_read_timeout    300s;
    proxy_buffering off;
}

location /${INSTANCE_NAME}/dhis-web-commons-stream {
    proxy_pass http://${CONTAINER_IP}:8080/dhis-web-commons-stream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_read_timeout 86400;
}
EOF

    log "writing base vhost ${SITE_FILE}"
    cat > "${SITE_FILE}" <<EOF
# Shared base vhost for ${BASE_DOMAIN}. Per-instance location blocks
# live in ${UPSTREAM_DIR}/<instance>.conf and are pulled in by the
# include directive inside the TLS server{} below. This file is
# regenerated by configure-host-proxy.sh and is safe to recreate.
server {
    listen 80;
    listen [::]:80;
    server_name ${BASE_DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${BASE_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${BASE_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${BASE_DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 100M;

    access_log /var/log/nginx/${BASE_DOMAIN}_access.log;
    error_log  /var/log/nginx/${BASE_DOMAIN}_error.log;

    # Per-instance location blocks (one file per DHIS2 instance).
    include ${UPSTREAM_DIR}/*.conf;
}
EOF
else
    # ---- subdomain: <instance>.dhis2.example.org ----
    log "writing upstream ${UPSTREAM_FILE}"
    cat > "${UPSTREAM_FILE}" <<EOF
upstream dhis2_${VMID} {
    server ${CONTAINER_IP}:8080 fail_timeout=0;
    keepalive 32;
}
EOF

    log "writing site ${SITE_FILE}"
    cat > "${SITE_FILE}" <<EOF
# HTTP → HTTPS redirect.
server {
    listen 80;
    listen [::]:80;
    server_name ${BASE_DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${BASE_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${BASE_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${BASE_DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 100M;

    access_log /var/log/nginx/${BASE_DOMAIN}_access.log;
    error_log  /var/log/nginx/${BASE_DOMAIN}_error.log;

    location / {
        proxy_pass http://dhis2_${VMID};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 300s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
        proxy_buffering off;
    }

    location /dhis-web-commons-stream {
        proxy_pass http://dhis2_${VMID}/dhis-web-commons-stream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}
EOF
fi

# Detect the conf.d layout: when sites-available and sites-enabled resolve
# to the same directory, SITE_LINK == SITE_FILE and `ln -sf` would
# replace the freshly-written config with a broken self-symlink. Guard
# against that by only creating the symlink when the two dirs differ
# (the classic Debian sites-available + sites-enabled split).
if [[ "${SITES_AVAILABLE}" != "${SITES_ENABLED}" ]]; then
    ln -sf "${SITE_FILE}" "${SITE_LINK}"
fi

if [[ ${SKIP_CERTBOT} -eq 0 ]]; then
    log "requesting Let's Encrypt certificate for ${BASE_DOMAIN}"
    # certbot may legitimately fail (DNS, rate limit) — don't tear down the
    # config; the caller can re-run certbot later. We DO fail the script
    # so the orchestrator knows TLS isn't ready. In path-based mode the
    # cert is issued once for the base FQDN and shared by every instance
    # under it; certbot certonly is idempotent so re-running per instance
    # is harmless (it just renews / reports 'cert not yet due').
    certbot certonly --nginx \
        -d "${BASE_DOMAIN}" \
        --non-interactive \
        --agree-tos \
        --email "${EMAIL}"
fi

log "validating and reloading nginx"
nginx -t
systemctl reload nginx

if [[ "${ROUTING_MODE}" == "path" ]]; then
    log "central-host Nginx ready for https://${BASE_DOMAIN}/${INSTANCE_NAME}/ → ${CONTAINER_IP}:8080"
else
    log "central-host Nginx ready for https://${BASE_DOMAIN} → ${CONTAINER_IP}:8080"
fi
