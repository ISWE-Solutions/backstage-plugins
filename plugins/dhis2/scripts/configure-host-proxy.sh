#!/usr/bin/env bash
# configure-host-proxy.sh — central Nginx + Let's Encrypt for one DHIS2 instance.
#
# Runs on the Proxmox host (where the central Nginx terminates TLS and
# reverse-proxies to the per-instance LXC container's Tomcat:8080).
#
# Extracted verbatim-ish from the original provision-instance.sh steps 7-8
# but with flag-based args and an unwind path on failure.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: configure-host-proxy.sh [options]

Required:
  --vmid <int>              Proxmox VMID (used in upstream name)
  --container-ip <ip>       IPv4 of the LXC container's Tomcat
  --domain <fqdn>           Public domain (server_name + certbot)
  --email <addr>            Email for Let's Encrypt notifications

Optional:
  --upstream-dir <dir>      Nginx upstream snippets dir
                            (default: /etc/nginx/conf.d/dhis2-upstreams)
  --sites-available <dir>   Default: /etc/nginx/sites-available
  --sites-enabled <dir>     Default: /etc/nginx/sites-enabled
  --skip-certbot            Don't request a Let's Encrypt cert (useful for dev)
  --remove                  Tear down the upstream/site for this --vmid/--domain
                            instead of creating it
  -h | --help               Show this help
EOF
}

UPSTREAM_DIR="/etc/nginx/conf.d/dhis2-upstreams"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
SKIP_CERTBOT=0
REMOVE=0

VMID=""; CONTAINER_IP=""; DOMAIN=""; EMAIL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vmid) VMID="$2"; shift 2;;
        --container-ip) CONTAINER_IP="$2"; shift 2;;
        --domain) DOMAIN="$2"; shift 2;;
        --email) EMAIL="$2"; shift 2;;
        --upstream-dir) UPSTREAM_DIR="$2"; shift 2;;
        --sites-available) SITES_AVAILABLE="$2"; shift 2;;
        --sites-enabled) SITES_ENABLED="$2"; shift 2;;
        --skip-certbot) SKIP_CERTBOT=1; shift;;
        --remove) REMOVE=1; shift;;
        -h|--help) usage; exit 0;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
    esac
done

log() { printf '[host-proxy] %s\n' "$*" >&2; }

UPSTREAM_FILE="${UPSTREAM_DIR}/dhis2-${VMID}.conf"
SITE_FILE="${SITES_AVAILABLE}/dhis2-${DOMAIN}.conf"
SITE_LINK="${SITES_ENABLED}/dhis2-${DOMAIN}.conf"

if [[ ${REMOVE} -eq 1 ]]; then
    [[ -n "${VMID}" && -n "${DOMAIN}" ]] || { echo "--remove needs --vmid and --domain" >&2; exit 2; }
    log "removing nginx config for VMID=${VMID} domain=${DOMAIN}"
    rm -f "${UPSTREAM_FILE}" "${SITE_LINK}" "${SITE_FILE}"
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

mkdir -p "${UPSTREAM_DIR}" "${SITES_AVAILABLE}" "${SITES_ENABLED}"

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
    server_name ${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 100M;

    access_log /var/log/nginx/${DOMAIN}_access.log;
    error_log  /var/log/nginx/${DOMAIN}_error.log;

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

ln -sf "${SITE_FILE}" "${SITE_LINK}"

if [[ ${SKIP_CERTBOT} -eq 0 ]]; then
    log "requesting Let's Encrypt certificate for ${DOMAIN}"
    # certbot may legitimately fail (DNS, rate limit) — don't tear down the
    # config; the caller can re-run certbot later. We DO fail the script
    # so the orchestrator knows TLS isn't ready.
    certbot certonly --nginx \
        -d "${DOMAIN}" \
        --non-interactive \
        --agree-tos \
        --email "${EMAIL}"
fi

log "validating and reloading nginx"
nginx -t
systemctl reload nginx

log "central-host Nginx ready for https://${DOMAIN} → ${CONTAINER_IP}:8080"
