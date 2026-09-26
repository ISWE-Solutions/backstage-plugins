import https from 'node:https';
import http from 'node:http';

export interface PhpIpamResponse {
  status: number;
  body: unknown;
}

export interface PhpIpamClient {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<PhpIpamResponse>;
}

/**
 * Minimal phpIPAM API client. Uses node's http(s) module rather than fetch so
 * TLS verification can be turned off for phpIPAM's self-signed certificate
 * without affecting any other outbound request.
 */
export function createPhpIpamClient(options: {
  url: string;
  appCode: string;
  verifyTls: boolean;
}): PhpIpamClient {
  const base = new URL(
    options.url.endsWith('/') ? options.url : `${options.url}/`,
  );
  const agent =
    base.protocol === 'https:'
      ? new https.Agent({
          rejectUnauthorized: options.verifyTls,
          keepAlive: true,
        })
      : undefined;

  return {
    request(method, path, body) {
      const target = new URL(path.replace(/^\/+/, ''), base);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const transport = target.protocol === 'https:' ? https : http;
      return new Promise((resolve, reject) => {
        const req = transport.request(
          target,
          {
            method,
            agent,
            timeout: 30_000,
            headers: {
              token: options.appCode,
              Accept: 'application/json',
              ...(payload
                ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                  }
                : {}),
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
                // phpIPAM returned non-JSON (e.g. an Apache error page)
              }
              resolve({ status: res.statusCode ?? 502, body: parsed });
            });
          },
        );
        req.on('timeout', () =>
          req.destroy(new Error('phpIPAM request timed out')),
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
