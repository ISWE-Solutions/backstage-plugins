import { IPAddress, IPStatus } from './types';

export type AttentionCategory =
  | 'conflict'
  | 'unknown'
  | 'sharedMac'
  | 'stale'
  | 'stoppedGuest';

export interface AttentionItem {
  category: AttentionCategory;
  address: IPAddress;
  detail: string;
}

export const CATEGORY_INFO: Record<
  AttentionCategory,
  { label: string; description: string }
> = {
  conflict: {
    label: 'Conflicting device',
    description:
      'Discovery sources report different MAC addresses for this IP — two devices may be using it.',
  },
  unknown: {
    label: 'Unknown device',
    description:
      'Answers on the network but matches no Proxmox guest, DHCP lease or manual record.',
  },
  sharedMac: {
    label: 'Shared MAC',
    description:
      'The same MAC address holds addresses recorded under different hostnames.',
  },
  stale: {
    label: 'Stale',
    description:
      'Marked offline, or has not answered a ping for longer than the chosen period.',
  },
  stoppedGuest: {
    label: 'Held by stopped guest',
    description:
      'Assigned to a Proxmox guest that is stopped — reclaim it if the guest is retired.',
  },
};

/** Order in which categories are shown, most urgent first */
export const CATEGORY_ORDER: AttentionCategory[] = [
  'conflict',
  'unknown',
  'sharedMac',
  'stale',
  'stoppedGuest',
];

const CONFLICT_MARKER = 'conflict:';

const ipSortKey = (ip: string) =>
  ip.split('.').reduce((acc, part) => acc * 256 + (Number(part) || 0), 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const noteLine = (note: string | undefined, marker: string) =>
  (note ?? '')
    .split('\n')
    .find(l => l.startsWith(marker))
    ?.slice(marker.length)
    .trim();

/**
 * Addresses that need a person's attention, derived from what phpIPAM and
 * the discovery sync record. An address can appear in several categories.
 */
export function findAttentionItems(
  addresses: IPAddress[],
  options: { now?: Date; staleDays: number },
): AttentionItem[] {
  const now = (options.now ?? new Date()).getTime();
  const items: AttentionItem[] = [];

  for (const address of addresses) {
    const conflict = noteLine(address.notes, CONFLICT_MARKER);
    if (conflict) {
      items.push({ category: 'conflict', address, detail: conflict });
    }

    if (address.source === 'scan') {
      items.push({
        category: 'unknown',
        address,
        detail: address.macAddress
          ? `MAC ${address.macAddress}`
          : 'No MAC recorded',
      });
    }

    const stopped = address.description?.includes('(stopped)') ?? false;
    if (stopped) {
      items.push({
        category: 'stoppedGuest',
        address,
        detail: address.description!,
      });
    }

    if (address.status === IPStatus.OFFLINE) {
      items.push({ category: 'stale', address, detail: 'Tagged Offline' });
    } else if (!stopped && address.lastSeen) {
      const age = Math.floor(
        (now - new Date(address.lastSeen).getTime()) / DAY_MS,
      );
      if (age > options.staleDays) {
        items.push({
          category: 'stale',
          address,
          detail: `Last answered a ping ${age} days ago`,
        });
      }
    }
  }

  // one MAC holding addresses under different hostnames (one host with
  // several addresses, e.g. a Proxmox node's bridges, is fine)
  const byMac = new Map<string, IPAddress[]>();
  for (const a of addresses) {
    if (!a.macAddress) continue;
    const mac = a.macAddress.toLowerCase();
    byMac.set(mac, [...(byMac.get(mac) ?? []), a]);
  }
  for (const [mac, group] of byMac) {
    const hostnames = new Set(
      group.map(a => (a.hostname ?? '').toLowerCase()).filter(Boolean),
    );
    if (group.length > 1 && hostnames.size > 1) {
      const others = (a: IPAddress) =>
        group
          .filter(o => o !== a)
          .map(o => `${o.ipAddress} (${o.hostname || 'no hostname'})`)
          .join(', ');
      for (const a of group) {
        items.push({
          category: 'sharedMac',
          address: a,
          detail: `${mac} also on ${others(a)}`,
        });
      }
    }
  }

  return items.sort(
    (x, y) =>
      CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) ||
      ipSortKey(x.address.ipAddress) - ipSortKey(y.address.ipAddress),
  );
}
