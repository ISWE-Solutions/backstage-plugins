import https from 'node:https';
import http from 'node:http';

export interface ProxmoxResponse {
  status: number;
  body: unknown;
}

export interface ProxmoxClient {
  /** GET /api2/json{path}; returns the parsed `data` payload */
  get(path: string): Promise<ProxmoxResponse>;
}

/**
 * Minimal Proxmox VE API client. Uses node's http(s) module rather than fetch
 * so TLS verification can be turned off for Proxmox's self-signed certificate
 * without affecting any other outbound request. Authenticates with an API
 * token header (`Authorization: PVEAPIToken=user@realm!tokenid=secret`), the
 * same scheme the ipam sync uses.
 */
export function createProxmoxClient(options: {
  url: string;
  token: string;
  verifyTls: boolean;
}): ProxmoxClient {
  const trimmed = options.url.replace(/\/+$/, '');
  const base = new URL(`${trimmed}/api2/json/`);
  const agent =
    base.protocol === 'https:'
      ? new https.Agent({
          rejectUnauthorized: options.verifyTls,
          keepAlive: true,
        })
      : undefined;

  return {
    get(path) {
      const target = new URL(path.replace(/^\/+/, ''), base);
      const transport = target.protocol === 'https:' ? https : http;
      return new Promise((resolve, reject) => {
        const req = transport.request(
          target,
          {
            method: 'GET',
            agent,
            timeout: 30_000,
            headers: {
              Authorization: `PVEAPIToken=${options.token}`,
              Accept: 'application/json',
            },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown = text;
              try {
                parsed = text ? JSON.parse(text) : {};
              } catch {
                // Proxmox returned non-JSON (e.g. an auth failure HTML page)
              }
              resolve({ status: res.statusCode ?? 502, body: parsed });
            });
          },
        );
        req.on('timeout', () =>
          req.destroy(new Error('Proxmox request timed out')),
        );
        req.on('error', reject);
        req.end();
      });
    },
  };
}
