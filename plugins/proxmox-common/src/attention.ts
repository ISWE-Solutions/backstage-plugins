import { AttentionItem, ProxmoxResources } from './types';

export interface AttentionThresholds {
  /** Storage usage fraction above which a pool is flagged (default 0.9) */
  storageFull: number;
  /** Node memory fraction above which a node is flagged (default 0.9) */
  nodeMemoryHigh: number;
  /** Guest memory fraction above which a running guest is flagged (default 0.95) */
  guestMemoryHigh: number;
}

export const DEFAULT_THRESHOLDS: AttentionThresholds = {
  storageFull: 0.9,
  nodeMemoryHigh: 0.9,
  guestMemoryHigh: 0.95,
};

const guestLabel = (name: string, type: string, vmid: number) =>
  `${name} (${type === 'lxc' ? 'LXC' : 'VM'} ${vmid})`;

/**
 * Cluster health checks in the spirit of Pulse "Patrol": surface what needs
 * attention (offline nodes, stopped guests, near-full or inactive storage,
 * memory pressure) rather than making someone read every gauge.
 */
export function findAttentionItems(
  resources: Pick<ProxmoxResources, 'nodes' | 'guests' | 'storage'>,
  thresholds: Partial<AttentionThresholds> = {},
): AttentionItem[] {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const items: AttentionItem[] = [];

  for (const n of resources.nodes) {
    if (n.status !== 'online') {
      items.push({
        category: 'nodeOffline',
        severity: 'high',
        subject: n.node,
        node: n.node,
        detail: `Node status is ${n.status}`,
      });
      continue; // an offline node's memory reading is meaningless
    }
    const memFrac = n.maxmem ? n.mem / n.maxmem : 0;
    if (memFrac >= t.nodeMemoryHigh) {
      items.push({
        category: 'nodeMemoryHigh',
        severity: 'warning',
        subject: n.node,
        node: n.node,
        detail: `Memory ${(memFrac * 100).toFixed(0)}% used`,
      });
    }
  }

  for (const g of resources.guests) {
    if (g.template) continue;
    if (g.status === 'stopped') {
      items.push({
        category: 'guestStopped',
        severity: 'warning',
        subject: guestLabel(g.name, g.type, g.vmid),
        node: g.node,
        detail: `Stopped on ${g.node}`,
      });
      continue;
    }
    if (g.status === 'running' && g.maxmem) {
      const frac = g.mem / g.maxmem;
      if (frac >= t.guestMemoryHigh) {
        items.push({
          category: 'guestMemoryHigh',
          severity: 'warning',
          subject: guestLabel(g.name, g.type, g.vmid),
          node: g.node,
          detail: `Memory ${(frac * 100).toFixed(0)}% used`,
        });
      }
    }
  }

  for (const s of resources.storage) {
    if (s.enabled && !s.active) {
      items.push({
        category: 'storageInactive',
        severity: 'high',
        subject: s.storage,
        node: s.node,
        detail: `Enabled but inactive on ${s.node}`,
      });
    }
    if (s.total && s.usage >= t.storageFull) {
      items.push({
        category: 'storageFull',
        severity: s.usage >= 0.95 ? 'high' : 'warning',
        subject: s.storage,
        node: s.node,
        detail: `${(s.usage * 100).toFixed(0)}% used on ${s.node}`,
      });
    }
  }

  // high severity first, then by subject for stable ordering
  const rank = { high: 0, warning: 1 } as const;
  return items.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.subject.localeCompare(b.subject),
  );
}
