# DHIS2 Orchestration Plugin - Quick Start Guide

## What is This Plugin?

The DHIS2 Orchestration Plugin allows you to create, manage, and orchestrate DHIS2 (District Health Information Software 2) instances on LXC containers running in a Proxmox virtualization cluster. All instances share a centralized Nginx reverse proxy for SSL termination and routing.

## Key Capabilities

✅ **Create DHIS2 Instances** - Automatically provision complete DHIS2 installations  
✅ **Manage Lifecycle** - Start, stop, restart, and delete instances  
✅ **Resource Management** - Configure CPU, memory, and storage per instance  
✅ **Shared Nginx Proxy** - Centralized SSL and domain routing  
✅ **Multi-Node Support** - Distribute instances across Proxmox cluster nodes  
✅ **Version Selection** - Choose from multiple DHIS2 versions  
✅ **Dashboard** - Monitor all instances, nodes, and proxy configuration  

## Quick Demo (Mock Data)

The plugin includes mock data so you can explore the UI immediately:

1. **Start Backstage:**
   ```bash
   cd /home/chisanga/backstage
   yarn dev
   ```

2. **Access the Plugin:**
   - Open http://localhost:3000
   - Click "DHIS2" in the sidebar (cloud icon)
   - Or navigate directly to http://localhost:3000/dhis2

3. **Explore the Interface:**
   - View 3 sample instances (Production, Testing, Development)
   - See statistics (instances, CPU, memory)
   - Browse the Cluster Nodes tab
   - Check the Nginx Configuration tab
   - Try the "Create Instance" button to see the form

## Production Setup Requirements

To use this plugin with real infrastructure:

### 1. Proxmox VE Cluster
- **Version:** 7.0 or later
- **Access:** API token with appropriate permissions
- **Storage:** Local or shared storage for containers
- **Network:** VLAN or bridge for containers
- **Template:** Ubuntu 22.04 LXC template

### 2. Nginx Proxy Server
- **OS:** Linux (Ubuntu/Debian recommended)
- **Software:** Nginx, Certbot
- **Access:** SSH access with key-based authentication
- **Ports:** 80 (HTTP), 443 (HTTPS) open to internet
- **DNS:** Wildcard DNS or per-domain records

### 3. Backend API Service
- **Runtime:** Node.js 18+ or similar
- **Framework:** Express.js recommended
- **Database:** PostgreSQL for instance metadata
- **Endpoints:** See `/docs/dhis2-backend-api-example.md`

## Architecture Diagram

```
┌─────────────────────────────────────────────┐
│           Backstage UI (DHIS2 Plugin)       │
│              http://localhost:3000/dhis2    │
└─────────────────┬───────────────────────────┘
                  │
                  │ REST API Calls
                  │
┌─────────────────▼───────────────────────────┐
│        Backend API Service                  │
│      (Node.js/Express + Services)           │
└────┬──────────────┬─────────────────────────┘
     │              │
     │ Proxmox API  │ SSH/Config
     │              │
┌────▼────────┐  ┌─▼──────────────┐
│  Proxmox    │  │ Nginx Proxy    │
│  Cluster    │  │   Server       │
│             │  │                │
│  Node: pve1 │  │  SSL Certs     │
│  ┌────────┐ │  │  Port 443      │
│  │LXC: 100│◄┼──┤  Routing       │
│  │DHIS2   │ │  │                │
│  └────────┘ │  └────────────────┘
│             │
│  Node: pve2 │        Internet
│  ┌────────┐ │           ▲
│  │LXC: 101│◄┼───────────┘
│  │DHIS2   │ │  https://dhis2.example.com
│  └────────┘ │
└─────────────┘
```

## Step-by-Step Production Setup

### Step 1: Prepare Proxmox Cluster

```bash
# On Proxmox server:

# 1. Create API token
pveum user token add root@pam backstage --privsep=0

# 2. Download Ubuntu template
pveam update
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst

# 3. Verify storage
pvesm status

# 4. Check network configuration
cat /etc/network/interfaces
```

### Step 2: Set Up Nginx Proxy Server

```bash
# On dedicated Nginx server:

# 1. Install Nginx and Certbot
apt update
apt install -y nginx certbot python3-certbot-nginx

# 2. Create directory structure
mkdir -p /etc/nginx/conf.d/dhis2-upstreams
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

# 3. Configure base settings
cat > /etc/nginx/nginx.conf <<'EOF'
user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 768;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    
    # Include DHIS2 upstreams
    include /etc/nginx/conf.d/dhis2-upstreams/*.conf;
    
    # Include DHIS2 sites
    include /etc/nginx/sites-enabled/*;
}
EOF

# 4. Test and restart
nginx -t
systemctl restart nginx
systemctl enable nginx
```

### Step 3: Create Backend API

Follow the guide in `/docs/dhis2-backend-api-example.md` to implement the backend API service.

**Key endpoints to implement:**
- `GET /api/dhis2/instances` - List instances
- `POST /api/dhis2/instances` - Create instance
- `POST /api/dhis2/instances/:id/start` - Start instance
- `POST /api/dhis2/instances/:id/stop` - Stop instance
- `DELETE /api/dhis2/instances/:id` - Delete instance
- `GET /api/dhis2/nodes` - List Proxmox nodes
- `GET /api/dhis2/versions` - List DHIS2 versions

### Step 4: Configure Environment Variables

Create `.env` file in Backstage backend:

```bash
# Proxmox Configuration
PROXMOX_HOST=proxmox.example.com
PROXMOX_PORT=8006
PROXMOX_TOKEN=root@pam!backstage
PROXMOX_SECRET=your-secret-token-here
PROXMOX_VERIFY_SSL=false

# Nginx Configuration
NGINX_HOST=nginx.example.com
NGINX_SSH_PORT=22
NGINX_SSH_USER=root
NGINX_SSH_KEY=/path/to/private/key

# DHIS2 Configuration
DHIS2_DEFAULT_VERSION=2.40.3
```

### Step 5: Test the System

```bash
# 1. Start Backstage
cd /home/chisanga/backstage
yarn dev

# 2. Navigate to DHIS2 plugin
open http://localhost:3000/dhis2

# 3. Create a test instance
# - Click "Create Instance"
# - Fill in the form
# - Submit

# 4. Monitor provisioning
# - Watch the instance status change
# - Check Proxmox UI for container creation
# - Verify Nginx configuration
# - Test DHIS2 access via domain
```

## Creating Your First Instance

1. **Click "Create Instance"** button in the dashboard

2. **Fill in the form:**
   - **Instance Name:** "DHIS2 Production"
   - **Domain:** dhis2-prod.example.com
   - **DHIS2 Version:** 2.40.3 (or latest)
   - **Proxmox Node:** pve1 (or available node)
   - **CPU Cores:** 4
   - **Memory:** 8192 MB (8 GB)
   - **Storage:** 100 GB
   - **Database Name:** dhis2_prod
   - **Database User:** dhis2
   - **Database Password:** [strong password]
   - **Admin Password:** [strong password]

3. **Click "Create Instance"**

4. **Wait for provisioning** (5-10 minutes):
   - Container creation
   - System installation
   - DHIS2 setup
   - Database configuration
   - Nginx configuration
   - SSL certificate

5. **Access your DHIS2 instance:**
   - URL: https://dhis2-prod.example.com
   - Username: admin
   - Password: [admin password you set]

## Troubleshooting

### Instance Won't Start
```bash
# Check container status in Proxmox
pct status <vmid>

# View container logs
pct exec <vmid> -- tail -f /var/lib/tomcat9/logs/catalina.out

# Check resources
pct config <vmid>
```

### Domain Not Accessible
```bash
# Test DNS resolution
nslookup dhis2-prod.example.com

# Check Nginx configuration
nginx -t

# View Nginx logs
tail -f /var/log/nginx/dhis2-prod.example.com_error.log
```

### Database Connection Errors
```bash
# Connect to container
pct enter <vmid>

# Check PostgreSQL
systemctl status postgresql
psql -U dhis2 -d dhis2_prod -c "SELECT version();"

# Review DHIS2 configuration
cat /opt/dhis2/config/dhis.conf
```

## Resource Recommendations

### Development/Testing
- **CPU:** 2 cores
- **Memory:** 4 GB
- **Storage:** 20 GB
- **Expected Load:** < 100 users

### Production (Small)
- **CPU:** 4 cores
- **Memory:** 8 GB
- **Storage:** 100 GB
- **Expected Load:** 100-500 users

### Production (Medium)
- **CPU:** 8 cores
- **Memory:** 16 GB
- **Storage:** 250 GB
- **Expected Load:** 500-2000 users

### Production (Large)
- **CPU:** 16 cores
- **Memory:** 32 GB
- **Storage:** 500 GB
- **Expected Load:** 2000+ users

## Security Best Practices

✅ Always use HTTPS with valid SSL certificates  
✅ Use strong, unique passwords for each instance  
✅ Restrict direct container access via firewall  
✅ Keep DHIS2 and system packages updated  
✅ Enable PostgreSQL authentication  
✅ Regular backups of databases and configurations  
✅ Monitor logs for suspicious activity  
✅ Implement fail2ban for brute force protection  

## Provisioning (hybrid Bash + Ansible)

Instance provisioning is a hybrid pipeline: a thin Bash layer handles the
Proxmox-native parts (LXC creation, SSH bootstrap, central Nginx + Let's
Encrypt), and a self-contained set of in-tree Ansible roles configures
everything *inside* the container over SSH. No upstream Ansible dependency.

```
plugins/dhis2/
├── scripts/
│   ├── create-container.sh      # Proxmox: pvesh/pct + SSH bootstrap
│   ├── configure-host-proxy.sh  # central Nginx + certbot (on PVE host)
│   └── create-instance.sh       # orchestrator: phases 1 → 2 → 3
└── ansible/
    ├── ansible.cfg
    ├── site.yml                 # plays the in-tree roles
    ├── inventory/hosts.tmpl     # rendered at runtime via envsubst
    ├── group_vars/all.yml
    └── roles/
        ├── common/              # apt + base pkgs + timezone
        ├── postgres/            # PostgreSQL + extensions + tuning
        └── dhis2/               # Tomcat + WAR + dhis.conf
```

### First-time setup (on the Proxmox host)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_dhis2 -N ''
ansible-galaxy collection install -p plugins/dhis2/ansible/collections \
  community.general community.postgresql ansible.posix
```

### Provision an instance

Secrets are passed via env vars (never argv); the orchestrator renders a
mode-`0600` `vars.yml` in a temp dir and removes it on exit.

```bash
export DHIS2_DB_PASS='…'
export DHIS2_ADMIN_PASS='…'
export ROOT_PASSWORD='…'

cd plugins/dhis2/scripts
./create-instance.sh \
  --vmid 200 --node pve1 --hostname dhis2-prod \
  --domain dhis2.example.org --email admin@example.org \
  --dhis2-version 2.42 --db-name dhis2 --db-user dhis2 \
  --rollback-on-failure
```

Re-running is idempotent — Ansible will report `changed=0` for stable
roles. Tear-down: `./configure-host-proxy.sh --remove --vmid 200 --domain dhis2.example.org && pct destroy 200 --purge`.

## Getting Help

- **Plugin Documentation:** `/plugins/dhis2/README.md`
- **Backend Guide:** `/docs/dhis2-backend-api-example.md`
- **Implementation Summary:** `/docs/DHIS2_IMPLEMENTATION.md`
- **Provisioning Scripts:** `/plugins/dhis2/scripts/`
- **Ansible Playbook:** `/plugins/dhis2/ansible/site.yml`

**External Resources:**
- DHIS2: https://docs.dhis2.org/
- Proxmox: https://pve.proxmox.com/wiki/
- Nginx: https://nginx.org/en/docs/

## What's Next?

After setting up your first instance:

1. **Configure DHIS2:**
   - Set up organizational units
   - Configure data elements
   - Create user accounts
   - Import metadata

2. **Set Up Monitoring:**
   - Enable DHIS2 system monitoring
   - Configure alerts
   - Set up log aggregation
   - Monitor resource usage

3. **Plan for Scale:**
   - Add more nodes to cluster
   - Implement database replication
   - Configure load balancing
   - Set up disaster recovery

4. **Optimize Performance:**
   - Tune PostgreSQL settings
   - Configure DHIS2 caching
   - Enable Redis for sessions
   - Optimize Tomcat thread pools

## Support

For issues, questions, or contributions:
- Check the documentation in `/plugins/dhis2/`
- Review the implementation guide in `/docs/`
- Consult DHIS2 and Proxmox documentation

---

**Ready to orchestrate DHIS2 at scale!** 🚀
