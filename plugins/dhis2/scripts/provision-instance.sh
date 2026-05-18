#!/bin/bash
# DHIS2 Instance Provisioning Script
# This script creates a complete DHIS2 instance on an LXC container

set -e

# Configuration
VMID="$1"
NODE="$2"
HOSTNAME="$3"
DOMAIN="$4"
DHIS2_VERSION="$5"
DB_NAME="$6"
DB_USER="$7"
DB_PASS="$8"
ADMIN_PASS="$9"
CPU="${10:-4}"
MEMORY="${11:-8192}"
STORAGE="${12:-100}"

# Validate arguments
if [ -z "$VMID" ] || [ -z "$NODE" ] || [ -z "$HOSTNAME" ] || [ -z "$DOMAIN" ]; then
    echo "Usage: $0 <vmid> <node> <hostname> <domain> <dhis2_version> <db_name> <db_user> <db_pass> <admin_pass> [cpu] [memory] [storage]"
    exit 1
fi

echo "=========================================="
echo "DHIS2 Instance Provisioning"
echo "=========================================="
echo "VMID: $VMID"
echo "Node: $NODE"
echo "Hostname: $HOSTNAME"
echo "Domain: $DOMAIN"
echo "DHIS2 Version: $DHIS2_VERSION"
echo "CPU: $CPU cores"
echo "Memory: $MEMORY MB"
echo "Storage: $STORAGE GB"
echo "=========================================="

# Step 1: Create LXC container
echo "[1/8] Creating LXC container..."
pvesh create /nodes/$NODE/lxc \
    --vmid $VMID \
    --hostname $HOSTNAME \
    --ostemplate local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst \
    --memory $MEMORY \
    --cores $CPU \
    --rootfs local-lvm:$STORAGE \
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \
    --nameserver 8.8.8.8 \
    --features nesting=1 \
    --unprivileged 1 \
    --password "$ADMIN_PASS"

echo "[1/8] Starting container..."
pct start $VMID

echo "[1/8] Waiting for container to be ready..."
sleep 10

# Step 2: Update system and install dependencies
echo "[2/8] Installing system dependencies..."
pct exec $VMID -- bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get upgrade -y
    apt-get install -y \
        openjdk-11-jdk \
        postgresql-14 \
        postgresql-contrib \
        tomcat9 \
        tomcat9-admin \
        curl \
        wget \
        unzip \
        git
"

# Step 3: Configure PostgreSQL
echo "[3/8] Configuring PostgreSQL..."
pct exec $VMID -- bash -c "
    # Start PostgreSQL
    systemctl start postgresql
    systemctl enable postgresql
    
    # Create database and user
    sudo -u postgres psql -c \"CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';\"
    sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\"
    sudo -u postgres psql -d $DB_NAME -c \"CREATE EXTENSION IF NOT EXISTS postgis;\"
    sudo -u postgres psql -d $DB_NAME -c \"CREATE EXTENSION IF NOT EXISTS pg_trgm;\"
    sudo -u postgres psql -d $DB_NAME -c \"CREATE EXTENSION IF NOT EXISTS btree_gin;\"
    
    # Grant permissions
    sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;\"
    
    # Update PostgreSQL configuration for DHIS2
    echo \"max_connections = 200\" >> /etc/postgresql/14/main/postgresql.conf
    echo \"shared_buffers = 2GB\" >> /etc/postgresql/14/main/postgresql.conf
    
    # Restart PostgreSQL
    systemctl restart postgresql
"

# Step 4: Download and install DHIS2
echo "[4/8] Installing DHIS2 $DHIS2_VERSION..."
pct exec $VMID -- bash -c "
    # Download DHIS2 WAR file
    mkdir -p /opt/dhis2
    cd /opt/dhis2
    wget -O dhis.war https://releases.dhis2.org/$DHIS2_VERSION/dhis.war
    
    # Set ownership
    chown -R tomcat9:tomcat9 /opt/dhis2
"

# Step 5: Configure DHIS2
echo "[5/8] Configuring DHIS2..."
pct exec $VMID -- bash -c "
    # Create DHIS2 configuration directory
    mkdir -p /opt/dhis2/config
    
    # Create dhis.conf
    cat > /opt/dhis2/config/dhis.conf <<EOF
# Database connection
connection.dialect = org.hibernate.dialect.PostgreSQLDialect
connection.driver_class = org.postgresql.Driver
connection.url = jdbc:postgresql:$DB_NAME
connection.username = $DB_USER
connection.password = $DB_PASS

# Database pool
connection.pool.max_size = 80
connection.pool.min_size = 10

# Server configuration
server.base.url = https://$DOMAIN

# File storage
filestore.provider = filesystem
filestore.container = /opt/dhis2/files

# Analytics
analytics.cache.expiration = 3600

# System monitoring
system.monitoring.url =
system.monitoring.username =
system.monitoring.password =
EOF

    # Create files directory
    mkdir -p /opt/dhis2/files
    chown -R tomcat9:tomcat9 /opt/dhis2
    
    # Set DHIS2_HOME environment variable
    echo 'export DHIS2_HOME=/opt/dhis2/config' >> /etc/environment
    echo 'DHIS2_HOME=/opt/dhis2/config' >> /etc/default/tomcat9
"

# Step 6: Configure Tomcat
echo "[6/8] Configuring Tomcat..."
pct exec $VMID -- bash -c "
    # Remove default webapps
    rm -rf /var/lib/tomcat9/webapps/*
    
    # Copy DHIS2 WAR to Tomcat
    cp /opt/dhis2/dhis.war /var/lib/tomcat9/webapps/ROOT.war
    
    # Configure Tomcat memory settings
    cat > /etc/default/tomcat9 <<EOF
JAVA_OPTS=\"-Djava.awt.headless=true -Xmx4G -Xms2G\"
DHIS2_HOME=/opt/dhis2/config
EOF
    
    # Restart Tomcat
    systemctl restart tomcat9
    systemctl enable tomcat9
"

# Step 7: Configure Nginx upstream and server block
echo "[7/8] Configuring Nginx proxy..."

# Get container IP
CONTAINER_IP=$(pct exec $VMID -- hostname -I | awk '{print $1}')

# Create upstream configuration
cat > /etc/nginx/conf.d/dhis2-upstreams/dhis2-${VMID}.conf <<EOF
upstream dhis2_${VMID} {
    server ${CONTAINER_IP}:8080 fail_timeout=0;
    keepalive 32;
}
EOF

# Create server block
cat > /etc/nginx/sites-available/dhis2-${DOMAIN}.conf <<EOF
# HTTP to HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

# HTTPS server block
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # SSL configuration (will be managed by certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 100M;

    # Logging
    access_log /var/log/nginx/${DOMAIN}_access.log;
    error_log /var/log/nginx/${DOMAIN}_error.log;

    # Proxy to DHIS2
    location / {
        proxy_pass http://dhis2_${VMID};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    # WebSocket support
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

# Enable site
ln -sf /etc/nginx/sites-available/dhis2-${DOMAIN}.conf /etc/nginx/sites-enabled/

# Step 8: Request SSL certificate
echo "[8/8] Requesting SSL certificate..."
certbot certonly --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN || true

# Test and reload Nginx
echo "Testing Nginx configuration..."
nginx -t

echo "Reloading Nginx..."
systemctl reload nginx

echo "=========================================="
echo "DHIS2 Instance Provisioning Complete!"
echo "=========================================="
echo "Container VMID: $VMID"
echo "Container IP: $CONTAINER_IP"
echo "Domain: https://$DOMAIN"
echo "=========================================="
echo "DHIS2 is starting... This may take 2-3 minutes."
echo "Default credentials:"
echo "  Username: admin"
echo "  Password: $ADMIN_PASS"
echo "=========================================="
echo "Monitor startup: pct exec $VMID -- tail -f /var/lib/tomcat9/logs/catalina.out"
echo "=========================================="
