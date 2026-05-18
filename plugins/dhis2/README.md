# DHIS2 Orchestration Plugin

A Backstage plugin for orchestrating DHIS2 instances on LXC containers in a Proxmox cluster with shared Nginx reverse proxy.

## Features

- **Instance Management**: Create, start, stop, restart, and delete DHIS2 instances
- **Proxmox Integration**: Automatic LXC container provisioning on Proxmox VE cluster
- **Shared Nginx Proxy**: Centralized reverse proxy with SSL termination for all instances
- **Resource Management**: Configure CPU, memory, and storage for each instance
- **Database Configuration**: Automatic PostgreSQL database setup per instance
- **Multi-Node Support**: Distribute instances across multiple Proxmox nodes
- **Version Selection**: Choose from available DHIS2 versions
- **Monitoring Dashboard**: View instance status, resource usage, and cluster health

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Backstage UI                            │
│                   (DHIS2 Plugin)                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ REST API
                      │
┌─────────────────────▼───────────────────────────────────────┐
│              Backend API Server                             │
│   (Proxmox API Client + Nginx Config Manager)              │
└─────┬────────────────────────┬──────────────────────────────┘
      │                        │
      │ Proxmox API            │ SSH/Config Files
      │                        │
┌─────▼────────┐         ┌─────▼─────────┐
│   Proxmox    │         │ Nginx Proxy   │
│   Cluster    │         │   Server      │
│              │         │               │
│ ┌──────────┐ │         │ SSL Certs     │
│ │ LXC: 100 │ │         │ Domain Routes │
│ │ DHIS2    │◄├─────────┤ Load Balance  │
│ │ Prod     │ │         │               │
│ └──────────┘ │         └───────────────┘
│              │
│ ┌──────────┐ │
│ │ LXC: 101 │ │
│ │ DHIS2    │◄├─────────┐
│ │ Test     │ │         │
│ └──────────┘ │         │
│              │         │
│ ┌──────────┐ │         │
│ │ LXC: 102 │ │         │
│ │ DHIS2    │◄├─────────┘
│ │ Dev      │ │
│ └──────────┘ │
└──────────────┘
```

## Installation

This plugin is already integrated into the Backstage app. To use it:

1. Navigate to `/dhis2` or click "DHIS2" in the sidebar
2. Configure backend API endpoints (see Configuration section)
3. Ensure Proxmox cluster and Nginx proxy server are accessible

## Configuration

### Backend API Setup

Create a backend service that implements the following endpoints:

```typescript
// API Endpoints needed
GET  /api/dhis2/instances           - List all instances
POST /api/dhis2/instances           - Create new instance
GET  /api/dhis2/instances/:id       - Get instance details
POST /api/dhis2/instances/:id/start - Start instance
POST /api/dhis2/instances/:id/stop  - Stop instance
POST /api/dhis2/instances/:id/restart - Restart instance
DELETE /api/dhis2/instances/:id     - Delete instance

GET  /api/dhis2/nodes               - List Proxmox nodes
GET  /api/dhis2/versions            - List available DHIS2 versions

// Proxmox Integration
GET  /api/proxmox/nodes             - Query Proxmox cluster
POST /api/proxmox/lxc               - Create LXC container
GET  /api/proxmox/lxc/:vmid         - Get container status

// Nginx Configuration
POST /api/nginx/upstream            - Add upstream
POST /api/nginx/server              - Add server block
DELETE /api/nginx/upstream/:name    - Remove upstream
POST /api/nginx/reload              - Reload Nginx
```

### Proxmox Configuration

1. **API Token**: Create API token in Proxmox with appropriate permissions
   ```bash
   # In Proxmox web UI:
   # Datacenter > Permissions > API Tokens > Add
   ```

2. **LXC Template**: Prepare Ubuntu/Debian template with:
   - Java 11 or later
   - PostgreSQL 14+
   - Tomcat 9
   - Required DHIS2 dependencies

3. **Storage**: Ensure sufficient storage for containers

### Nginx Proxy Configuration

1. **Install Nginx** on dedicated proxy server:
   ```bash
   apt update
   apt install nginx certbot python3-certbot-nginx
   ```

2. **Base Configuration** (`/etc/nginx/nginx.conf`):
   ```nginx
   http {
       upstream_zone_size 64k;
       
       # Include all DHIS2 upstream configs
       include /etc/nginx/conf.d/dhis2-upstreams/*.conf;
       
       # Include all DHIS2 server blocks
       include /etc/nginx/sites-enabled/dhis2-*;
   }
   ```

3. **Directory Structure**:
   ```
   /etc/nginx/
   ├── conf.d/
   │   └── dhis2-upstreams/
   │       ├── dhis2-prod.conf
   │       ├── dhis2-test.conf
   │       └── dhis2-dev.conf
   ├── sites-available/
   │   ├── dhis2-prod.conf
   │   ├── dhis2-test.conf
   │   └── dhis2-dev.conf
   └── sites-enabled/
       ├── dhis2-prod.conf -> ../sites-available/dhis2-prod.conf
       ├── dhis2-test.conf -> ../sites-available/dhis2-test.conf
       └── dhis2-dev.conf -> ../sites-available/dhis2-dev.conf
   ```

## Instance Provisioning Process

When creating a new DHIS2 instance, the following steps are executed:

1. **Container Creation**:
   - Generate next available VMID
   - Create LXC container on selected Proxmox node
   - Configure resources (CPU, memory, storage)
   - Set hostname and network configuration

2. **DHIS2 Installation**:
   - Install Java and dependencies
   - Download and install specified DHIS2 version
   - Configure Tomcat for DHIS2

3. **Database Setup**:
   - Create PostgreSQL database
   - Create database user with permissions
   - Initialize DHIS2 schema
   - Load default data (optional)

4. **DHIS2 Configuration**:
   - Generate `dhis.conf` with database settings
   - Set admin password
   - Configure system settings

5. **Nginx Configuration**:
   - Generate upstream configuration
   - Create server block with domain
   - Request SSL certificate (Let's Encrypt)
   - Test and reload Nginx

6. **Health Check**:
   - Wait for DHIS2 to start
   - Verify HTTP 200 response
   - Update instance status to "running"

## Usage

### Creating an Instance

1. Click "Create Instance" button
2. Fill in the form:
   - **Instance Name**: Descriptive name (e.g., "DHIS2 Production")
   - **Domain Name**: FQDN for the instance (e.g., dhis2-prod.example.com)
   - **DHIS2 Version**: Select from available versions
   - **Proxmox Node**: Choose target node for container
   - **Resources**: Set CPU cores, memory (MB), and storage (GB)
   - **Database**: Configure database name, user, and password
   - **Admin Password**: Set DHIS2 admin user password
3. Click "Create Instance"
4. Wait for provisioning to complete (5-10 minutes)

### Managing Instances

- **Start**: Click play button to start stopped instance
- **Stop**: Click stop button to gracefully shutdown instance
- **Restart**: Click refresh button to restart running instance
- **Delete**: Click delete button to remove instance (with confirmation)

### Monitoring

- **Overview Tab**: View all instances with status, resources, and URLs
- **Cluster Nodes Tab**: See instance distribution across Proxmox nodes
- **Nginx Configuration Tab**: Review proxy configurations and SSL status

## Resource Recommendations

### Minimum Resources (Development/Testing)
- CPU: 2 cores
- Memory: 4 GB (4096 MB)
- Storage: 20 GB

### Recommended Resources (Production)
- CPU: 4-8 cores
- Memory: 8-16 GB (8192-16384 MB)
- Storage: 100-500 GB

### High-Load Production
- CPU: 8-16 cores
- Memory: 16-32 GB (16384-32768 MB)
- Storage: 500-1000 GB

## Network Configuration

Each LXC container should have:
- Static IP address in your network
- DNS resolution for the domain name
- Firewall rules allowing:
  - Port 8080 (DHIS2 Tomcat) - internal only
  - Port 5432 (PostgreSQL) - internal only
  - SSH access for management

Nginx proxy server should:
- Have public IP or be accessible via port forwarding
- Allow ports 80 and 443 from internet
- Have access to LXC container network

## Security Considerations

1. **SSL Certificates**: Always use HTTPS with valid SSL certificates
2. **Database Passwords**: Use strong, unique passwords for each instance
3. **Admin Passwords**: Enforce strong DHIS2 admin passwords
4. **Firewall**: Restrict direct access to containers, route through Nginx
5. **API Authentication**: Secure backend API with authentication tokens
6. **Container Security**: Keep LXC containers and DHIS2 updated
7. **Backup**: Regular backups of databases and configurations

## Troubleshooting

### Instance Won't Start
- Check Proxmox node resources (CPU, memory, storage)
- Verify LXC container status in Proxmox UI
- Check container logs: `pct exec <vmid> -- tail -f /var/log/tomcat9/catalina.out`

### Domain Not Accessible
- Verify DNS resolution: `nslookup domain.example.com`
- Check Nginx configuration: `nginx -t`
- Verify SSL certificate: `certbot certificates`
- Check Nginx logs: `/var/log/nginx/domain_error.log`

### Database Connection Errors
- Verify PostgreSQL is running in container
- Check database credentials in `/opt/dhis2/dhis.conf`
- Test database connection: `psql -h localhost -U dhis2 -d dhis2_db`

### Performance Issues
- Increase container resources via Proxmox UI
- Optimize DHIS2 configuration
- Enable database connection pooling
- Add more Tomcat threads

## Development

To modify this plugin:

1. Edit source files in `/plugins/dhis2/src/`
2. Update services in `/plugins/dhis2/src/services/`
3. Modify UI in `/plugins/dhis2/src/components/DHIS2Page.tsx`
4. Run `yarn start` to test changes

## Backend Implementation Example

See `docs/dhis2-backend-api-example.md` for a complete backend API implementation guide using Node.js/Express.

## License

Apache-2.0

## Support

For issues and questions:
- Check Proxmox documentation: https://pve.proxmox.com/wiki/
- DHIS2 documentation: https://docs.dhis2.org/
- Nginx documentation: https://nginx.org/en/docs/
