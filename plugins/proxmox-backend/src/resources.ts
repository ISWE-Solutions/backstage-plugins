import {
  ClusterInfo,
  GuestStatus,
  GuestType,
  NodeStatus,
  ProxmoxGuest,
  ProxmoxNode,
  ProxmoxResources,
  ProxmoxStorage,
} from '@iswesolutions/plugin-proxmox-common';
import { ProxmoxClient } from './proxmoxClient';

type Raw = Record<string, any>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const nodeStatus = (s: unknown): NodeStatus =>
  s === 'online' ? 'online' : s === 'offline' ? 'offline' : 'unknown';

const guestStatus = (s: unknown): GuestStatus =>
  s === 'running' || s === 'stopped' || s === 'paused'
    ? (s as GuestStatus)
    : 'unknown';

const parseTags = (v: unknown): string[] =>
  typeof v === 'string' && v.trim()
    ? v
        .split(/[;,\s]+/)
        .map(t => t.trim())
        .filter(Boolean)
    : [];

/** Turn one `/cluster/resources` list into typed nodes, guests and storage. */
export function mapResources(
  raw: Raw[],
  uiUrls: Record<string, string> = {},
): Pick<ProxmoxResources, 'nodes' | 'guests' | 'storage'> {
  const nodes: ProxmoxNode[] = [];
  const guests: ProxmoxGuest[] = [];
  const storage: ProxmoxStorage[] = [];

  for (const r of raw) {
    if (r.type === 'node') {
      nodes.push({
        node: String(r.node ?? ''),
        status: nodeStatus(r.status),
        cpu: num(r.cpu),
        maxcpu: num(r.maxcpu),
        mem: num(r.mem),
        maxmem: num(r.maxmem),
        uptime: num(r.uptime),
        uiUrl: uiUrls[String(r.node ?? '')],
      });
    } else if (r.type === 'qemu' || r.type === 'lxc') {
      const node = String(r.node ?? '');
      guests.push({
        id: String(r.id ?? `${r.type}/${r.vmid}`),
        vmid: num(r.vmid),
        type: r.type as GuestType,
        name: String(r.name ?? `${r.type}-${r.vmid ?? '?'}`),
        node,
        status: guestStatus(r.status),
        cpu: num(r.cpu),
        maxcpu: num(r.maxcpu),
        mem: num(r.mem),
        maxmem: num(r.maxmem),
        disk: num(r.disk),
        maxdisk: num(r.maxdisk),
        uptime: num(r.uptime),
        netin: num(r.netin),
        netout: num(r.netout),
        diskread: num(r.diskread),
        diskwrite: num(r.diskwrite),
        pool: r.pool ? String(r.pool) : undefined,
        template: String(r.template ?? '') === '1',
        tags: parseTags(r.tags),
        uiUrl: uiUrls[node],
      });
    } else if (r.type === 'storage') {
      const used = num(r.used ?? r.disk);
      const total = num(r.total ?? r.maxdisk);
      const avail =
        r.avail !== undefined ? num(r.avail) : Math.max(total - used, 0);
      storage.push({
        id: String(r.id ?? `storage/${r.node}/${r.storage}`),
        storage: String(r.storage ?? ''),
        node: String(r.node ?? ''),
        type: String(r.plugintype ?? r.type ?? ''),
        content: String(r.content ?? ''),
        used,
        total,
        avail,
        usage: total ? used / total : 0,
        shared: String(r.shared ?? '') === '1',
        // Proxmox omits these on older versions; default to enabled/active
        enabled: String(r.disable ?? '0') !== '1',
        active:
          r.status !== undefined
            ? r.status === 'available'
            : num(r.active) !== 0 || r.active === undefined,
      });
    }
  }

  nodes.sort((a, b) => a.node.localeCompare(b.node));
  guests.sort((a, b) => a.vmid - b.vmid);
  storage.sort(
    (a, b) =>
      a.node.localeCompare(b.node) || a.storage.localeCompare(b.storage),
  );
  return { nodes, guests, storage };
}

/** Cluster name/quorum from `/cluster/status`, falling back to node counts. */
export function mapCluster(
  statusRaw: Raw[] | undefined,
  nodes: ProxmoxNode[],
): ClusterInfo {
  const nodesOnline = nodes.filter(n => n.status === 'online').length;
  const info: ClusterInfo = {
    nodesOnline,
    nodesTotal: nodes.length,
  };
  const clusterEntry = (statusRaw ?? []).find(s => s.type === 'cluster');
  if (clusterEntry) {
    info.name = clusterEntry.name ? String(clusterEntry.name) : undefined;
    info.quorate = num(clusterEntry.quorate) === 1;
    if (clusterEntry.nodes !== undefined)
      info.nodesTotal = num(clusterEntry.nodes);
  }
  return info;
}

/** Fetch and aggregate the whole cluster state in one shot. */
export async function fetchResources(
  client: ProxmoxClient,
  uiUrls: Record<string, string> = {},
): Promise<ProxmoxResources> {
  const res = await client.get('cluster/resources');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Proxmox /cluster/resources returned ${res.status}`);
  }
  const list = ((res.body as any)?.data ?? []) as Raw[];
  const { nodes, guests, storage } = mapResources(list, uiUrls);

  let statusRaw: Raw[] | undefined;
  try {
    const st = await client.get('cluster/status');
    if (st.status >= 200 && st.status < 300) {
      statusRaw = ((st.body as any)?.data ?? []) as Raw[];
    }
  } catch {
    // a standalone (non-clustered) node has no /cluster/status; ignore
  }

  return {
    cluster: mapCluster(statusRaw, nodes),
    nodes,
    guests,
    storage,
    generatedAt: new Date().toISOString(),
  };
}
