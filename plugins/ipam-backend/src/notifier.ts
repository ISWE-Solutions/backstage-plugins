import { LoggerService } from '@backstage/backend-plugin-api';
import {
  findAttentionItems,
  IPAddress,
  Raw,
  toAddress,
} from '@internal/plugin-ipam-common';
import { PhpIpamClient } from './phpipamClient';

export interface NotableIssue {
  /** Stable identity: the same issue keeps the same key between runs */
  key: string;
  severity: 'high' | 'normal';
  text: string;
}

export interface SubnetUsage {
  id: string;
  cidr: string;
  percent: number;
}

export const DEFAULT_THRESHOLDS = [80, 90];

/**
 * Issues worth telling someone about: conflicting devices, unknown devices,
 * shared MACs, and subnets past a usage threshold. Stale addresses and
 * stopped guests are left to the Attention view — they would be noisy.
 */
export function notableIssues(
  addresses: IPAddress[],
  subnets: SubnetUsage[],
  thresholds: number[] = DEFAULT_THRESHOLDS,
): NotableIssue[] {
  const issues: NotableIssue[] = [];
  for (const item of findAttentionItems(addresses, { staleDays: Infinity })) {
    const a = item.address;
    const name = a.hostname ? `${a.ipAddress} (${a.hostname})` : a.ipAddress;
    if (item.category === 'conflict') {
      issues.push({
        key: `conflict:${a.ipAddress}`,
        severity: 'high',
        text: `Conflicting device on ${name}: ${item.detail}`,
      });
    } else if (item.category === 'unknown') {
      issues.push({
        key: `unknown:${a.ipAddress}:${(a.macAddress ?? '').toLowerCase()}`,
        severity: 'normal',
        text: `Unknown device on ${a.ipAddress} — ${item.detail}`,
      });
    } else if (item.category === 'sharedMac') {
      issues.push({
        key: `sharedMac:${a.ipAddress}:${(a.macAddress ?? '').toLowerCase()}`,
        severity: 'normal',
        text: `Shared MAC on ${name}: ${item.detail}`,
      });
    }
  }
  for (const s of subnets) {
    const crossed = thresholds.filter(t => s.percent >= t);
    if (crossed.length) {
      const t = Math.max(...crossed);
      issues.push({
        key: `subnet:${s.id}:${t}`,
        severity: t >= 90 ? 'high' : 'normal',
        text: `Subnet ${s.cidr} is ${Math.round(s.percent)}% used (past ${t}%)`,
      });
    }
  }
  return issues;
}

/** Remembers which issues have already been notified */
export interface IssueStore {
  keys(): Promise<string[]>;
  add(issues: NotableIssue[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface Notifier {
  send(options: {
    recipients: { type: 'entity'; entityRef: string[] };
    payload: {
      title: string;
      description: string;
      link: string;
      severity: 'high' | 'normal';
      topic: string;
    };
  }): Promise<void>;
}

const MAX_LINES = 10;

/**
 * One run: fetch phpIPAM, work out notable issues, notify the new ones in a
 * single digest, and forget resolved ones so a recurrence is notified again.
 */
export async function runNotifier(deps: {
  phpipam: PhpIpamClient;
  store: IssueStore;
  notifications: Notifier;
  recipients: string[];
  logger: LoggerService;
  thresholds?: number[];
}): Promise<NotableIssue[]> {
  const { phpipam, store, notifications, recipients, logger } = deps;

  const subnetsRaw =
    ((await phpipam.request('GET', 'subnets/')).body as any)?.data ?? [];
  const subnets: SubnetUsage[] = [];
  for (const s of subnetsRaw as Raw[]) {
    if (
      String(s.isFolder) === '1' ||
      !s.subnet ||
      String(s.subnet).includes(':')
    )
      continue;
    const usage = (
      (await phpipam.request('GET', `subnets/${s.id}/usage/`)).body as any
    )?.data;
    const max = Number(usage?.maxhosts ?? 0);
    subnets.push({
      id: String(s.id),
      cidr: `${s.subnet}/${s.mask}`,
      percent: max ? (Number(usage?.used ?? 0) / max) * 100 : 0,
    });
  }
  const addressesRaw =
    ((await phpipam.request('GET', 'addresses/')).body as any)?.data ?? [];
  const addresses = (addressesRaw as Raw[]).map(a => toAddress(a));

  const current = notableIssues(addresses, subnets, deps.thresholds);
  const known = new Set(await store.keys());
  const fresh = current.filter(i => !known.has(i.key));
  const resolved = [...known].filter(k => !current.some(i => i.key === k));

  if (resolved.length) await store.remove(resolved);
  if (!fresh.length) {
    logger.debug(`ipam: no new issues (${current.length} known)`);
    return [];
  }

  const lines = fresh.slice(0, MAX_LINES).map(i => `• ${i.text}`);
  if (fresh.length > MAX_LINES)
    lines.push(`…and ${fresh.length - MAX_LINES} more`);
  await notifications.send({
    recipients: { type: 'entity', entityRef: recipients },
    payload: {
      title: `IPAM: ${fresh.length} new issue${fresh.length === 1 ? '' : 's'}`,
      description: lines.join('\n'),
      link: '/ipam?tab=attention',
      severity: fresh.some(i => i.severity === 'high') ? 'high' : 'normal',
      topic: 'ipam',
    },
  });
  // record only after a successful send, so a failed send is retried
  await store.add(fresh);
  logger.info(
    `ipam: notified ${fresh.length} new issue(s) to ${recipients.join(', ')}`,
  );
  return fresh;
}
