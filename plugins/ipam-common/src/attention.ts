import { IPAddress, IPStatus } from './types';

export type AttentionCategory =
  | 'conflict'
  | 'unknown'
  | 'sharedMac'
  | 'drift'
  | 'dhcpPoolStatic'
  | 'stale'
  | 'staleReservation'
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
  drift: {
    label: 'Configuration drift',
    description:
      'The Proxmox guest departs from the standard setup — e.g. a resolver other than 10.20.30.8, or an address from DHCP instead of IPAM.',
  },
  dhcpPoolStatic: {
    label: 'Static in DHCP pool',
    description:
      'A non-DHCP address inside a DHCP pool — the DHCP server may hand the same address to another device.',
  },
  staleReservation: {
    label: 'Stale reservation',
    description:
      'Reserved but never seen on the network, and either unowned or reserved more than 30 days ago — release it or confirm it is still needed.',
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
  'drift',
  'dhcpPoolStatic',
  'stale',
  'staleReservation',
  'stoppedGuest',
];

export interface DhcpRange {
  from: string;
  to: string;
}

const RESERVATION_REVIEW_DAYS = 30;

const CONFLICT_MARKER = 'conflict:';
const DRIFT_MARKER = 'drift:';

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
  options: { now?: Date; staleDays: number; dhcpRanges?: DhcpRange[] },
): AttentionItem[] {
  const pools = (options.dhcpRanges ?? []).map(r => [
    ipSortKey(r.from),
    ipSortKey(r.to),
  ]);
  const now = (options.now ?? new Date()).getTime();
  const items: AttentionItem[] = [];

  for (const address of addresses) {
    const conflict = noteLine(address.notes, CONFLICT_MARKER);
    if (conflict) {
      items.push({ category: 'conflict', address, detail: conflict });
    }

    const drift = noteLine(address.notes, DRIFT_MARKER);
    if (drift) {
      items.push({ category: 'drift', address, detail: drift });
    }

    // Seen only on the wire (ping sweep and/or ARP table) — no Proxmox guest,
    // DHCP lease or manual record accounts for it. The sync rewrites scan
    // records as "arp" once the ARP table has them, so both count.
    const observedOnly =
      !!address.source &&
      address.source
        .split('+')
        .every(part => part === 'scan' || part === 'arp');
    if (observedOnly) {
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

    const key = ipSortKey(address.ipAddress);
    const inPool = pools.some(([lo, hi]) => key >= lo && key <= hi);
    if (
      inPool &&
      address.status !== IPStatus.DHCP &&
      !(address.source ?? '').split('+').includes('dhcp')
    ) {
      items.push({
        category: 'dhcpPoolStatic',
        address,
        detail: `Inside the DHCP pool but recorded as ${address.status} (${
          address.source ?? 'manual'
        })`,
      });
    }

    if (address.status === IPStatus.RESERVED && !address.lastSeen) {
      const allocated = /allocated:.* on (\d{4}-\d{2}-\d{2}T[^\s]+)/.exec(
        address.notes ?? '',
      )?.[1];
      const ageDays = allocated
        ? Math.floor((now - new Date(allocated).getTime()) / DAY_MS)
        : undefined;
      if (!address.assignedTo || (ageDays ?? 0) > RESERVATION_REVIEW_DAYS) {
        items.push({
          category: 'staleReservation',
          address,
          detail: !address.assignedTo
            ? 'Reserved with no owner'
            : `Reserved ${ageDays} days ago by ${address.assignedTo}, never seen`,
        });
      }
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
