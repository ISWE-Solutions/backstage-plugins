import { promises as dns } from 'node:dns';
import { Raw } from '@internal/plugin-ipam-common';

export interface DnsMismatch {
  ip: string;
  hostname: string;
  problem: string;
}

type Resolver = Pick<dns.Resolver, 'resolve4' | 'reverse'>;

/**
 * Compare phpIPAM hostnames with DNS:
 *  - a fully-qualified hostname (contains a dot) must resolve to the address;
 *  - if the address has reverse (PTR) names, one should match the hostname.
 * Bare hostnames are not checked forward (they are not DNS names), and
 * addresses without PTR records are not flagged — internal DNS has none.
 */
export async function checkDns(
  addresses: Raw[],
  resolver: Resolver,
  concurrency = 16,
): Promise<DnsMismatch[]> {
  const out: DnsMismatch[] = [];
  const todo = addresses.filter(
    a => a.hostname && a.ip && !String(a.ip).includes(':'),
  );
  const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const a = todo[i++];
      const ip = String(a.ip);
      const hostname = norm(String(a.hostname));
      if (hostname.includes('.')) {
        try {
          const ips = await resolver.resolve4(hostname);
          if (!ips.includes(ip)) {
            out.push({
              ip,
              hostname,
              problem: `${hostname} resolves to ${ips.join(', ')}, not ${ip}`,
            });
          }
        } catch (e: any) {
          out.push({
            ip,
            hostname,
            problem: `${hostname} does not resolve (${e?.code ?? 'error'})`,
          });
        }
      }
      try {
        const ptr = (await resolver.reverse(ip)).map(norm);
        const short = hostname.split('.')[0];
        if (
          ptr.length &&
          !ptr.some(p => p === hostname || p.split('.')[0] === short)
        ) {
          out.push({
            ip,
            hostname,
            problem: `reverse DNS for ${ip} is ${ptr.join(', ')}`,
          });
        }
      } catch {
        // no PTR record: normal on this network
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, worker),
  );
  return out.sort((x, y) =>
    x.ip.localeCompare(y.ip, undefined, { numeric: true }),
  );
}

export function createResolver(servers?: string[]): Resolver {
  const r = new dns.Resolver({ timeout: 2000, tries: 1 });
  if (servers?.length) r.setServers(servers);
  return r;
}
