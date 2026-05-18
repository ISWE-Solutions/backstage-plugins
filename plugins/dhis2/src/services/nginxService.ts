import { NginxConfig, NginxServer, NginxUpstream } from '../types';

/**
 * Service for managing Nginx reverse proxy configurations
 * Handles shared proxy for all DHIS2 instances
 */
export class NginxService {
  constructor(_baseUrl: string = '/api/nginx') {
    // baseUrl will be used when backend API is implemented
  }

  /**
   * Get current Nginx configuration
   */
  async getConfig(): Promise<NginxConfig> {
    // In production, this would read from Nginx config files or API
    return {
      upstreams: [
        {
          name: 'dhis2_prod',
          servers: ['10.0.0.100:8080'],
        },
        {
          name: 'dhis2_test',
          servers: ['10.0.0.101:8080'],
        },
      ],
      servers: [
        {
          domain: 'dhis2-prod.example.com',
          upstreamName: 'dhis2_prod',
          sslCert: '/etc/nginx/ssl/dhis2-prod.crt',
          sslKey: '/etc/nginx/ssl/dhis2-prod.key',
        },
        {
          domain: 'dhis2-test.example.com',
          upstreamName: 'dhis2_test',
          sslCert: '/etc/nginx/ssl/dhis2-test.crt',
          sslKey: '/etc/nginx/ssl/dhis2-test.key',
        },
      ],
    };
  }

  /**
   * Add upstream for a new DHIS2 instance
   */
  async addUpstream(upstream: NginxUpstream): Promise<void> {
    console.log('Adding Nginx upstream:', upstream);
    // In production:
    // 1. Generate upstream configuration
    // 2. Write to Nginx config file
    // 3. Test configuration
    // 4. Reload Nginx
  }

  /**
   * Remove upstream
   */
  async removeUpstream(name: string): Promise<void> {
    console.log('Removing Nginx upstream:', name);
    // In production:
    // 1. Remove upstream from config
    // 2. Test configuration
    // 3. Reload Nginx
  }

  /**
   * Add server block for a new DHIS2 instance
   */
  async addServer(server: NginxServer): Promise<void> {
    console.log('Adding Nginx server block:', server);
    // In production:
    // 1. Generate server block configuration
    // 2. Write to sites-available
    // 3. Create symlink to sites-enabled
    // 4. Test configuration
    // 5. Reload Nginx
  }

  /**
   * Remove server block
   */
  async removeServer(domain: string): Promise<void> {
    console.log('Removing Nginx server block:', domain);
    // In production:
    // 1. Remove symlink from sites-enabled
    // 2. Remove config from sites-available
    // 3. Test configuration
    // 4. Reload Nginx
  }

  /**
   * Generate complete configuration for a DHIS2 instance
   */
  generateInstanceConfig(
    domain: string,
    upstreamName: string,
    backendAddress: string,
  ): string {
    return `
# Upstream for ${domain}
upstream ${upstreamName} {
    server ${backendAddress} fail_timeout=0;
    keepalive 32;
}

# Server block for ${domain}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    # SSL configuration
    ssl_certificate /etc/nginx/ssl/${domain}.crt;
    ssl_certificate_key /etc/nginx/ssl/${domain}.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Max upload size
    client_max_body_size 100M;

    # Logging
    access_log /var/log/nginx/${domain}_access.log;
    error_log /var/log/nginx/${domain}_error.log;

    # Proxy settings
    location / {
        proxy_pass http://${upstreamName};
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;
        
        proxy_set_header Connection "";
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        proxy_buffering off;
        proxy_cache off;
    }

    # WebSocket support for DHIS2
    location /dhis-web-commons-stream {
        proxy_pass http://${upstreamName}/dhis-web-commons-stream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\\n";
        add_header Content-Type text/plain;
    }
}
`;
  }

  /**
   * Test Nginx configuration
   */
  async testConfig(): Promise<{ success: boolean; message: string }> {
    console.log('Testing Nginx configuration');
    // In production: Run `nginx -t`
    return { success: true, message: 'Configuration test successful' };
  }

  /**
   * Reload Nginx
   */
  async reload(): Promise<void> {
    console.log('Reloading Nginx');
    // In production: Run `systemctl reload nginx`
  }

  /**
   * Get SSL certificate info for domain
   */
  async getCertificateInfo(_domain: string): Promise<{
    valid: boolean;
    expiresAt?: string;
    issuer?: string;
  }> {
    // Mock data - in production, check actual certificate
    return {
      valid: true,
      expiresAt: '2026-12-31T23:59:59Z',
      issuer: "Let's Encrypt",
    };
  }

  /**
   * Request/renew SSL certificate using Let's Encrypt
   */
  async requestCertificate(domain: string, _email: string): Promise<void> {
    console.log('Requesting SSL certificate for:', domain);
    // In production: Use certbot or acme.sh
    // certbot certonly --nginx -d ${domain} --email ${email} --agree-tos --non-interactive
  }
}

export const nginxService = new NginxService();
