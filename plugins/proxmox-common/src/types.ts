/**
 * Shared types for the Proxmox monitoring plugin. The backend derives these
 * from Proxmox VE's `/cluster/resources` (and `/cluster/status`) so the
 * frontend never talks to Proxmox directly. Inspired by Pulse
 * (https://github.com/rcourtman/pulse): one shared resource model for the
 * whole cluster.
 */

export type GuestType = 'qemu' | 'lxc';
export type GuestStatus = 'running' | 'stopped' | 'paused' | 'unknown';
export type NodeStatus = 'online' | 'offline' | 'unknown';

/** A physical Proxmox host */
export interface ProxmoxNode {
  /** Node name, e.g. "pve10" */
  node: string;
  status: NodeStatus;
  /** CPU load as a fraction 0..1 */
  cpu: number;
  /** Number of CPU cores */
  maxcpu: number;
  /** Memory used / total, in bytes */
  mem: number;
  maxmem: number;
  /** Uptime in seconds */
  uptime: number;
  /** Web UI URL for the node, when configured */
  uiUrl?: string;
}

/** A VM (qemu) or container (lxc) */
export interface ProxmoxGuest {
  id: string;
  vmid: number;
  type: GuestType;
  name: string;
  node: string;
  status: GuestStatus;
  /** CPU use as a fraction 0..1 */
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  /** Disk use / size in bytes (0 when Proxmox does not report it) */
  disk: number;
  maxdisk: number;
  uptime: number;
  template: boolean;
  tags: string[];
  uiUrl?: string;
}

/** A storage pool */
export interface ProxmoxStorage {
  id: string;
  storage: string;
  node: string;
  type: string;
  content: string;
  used: number;
  total: number;
  avail: number;
  /** Fraction 0..1 */
  usage: number;
  shared: boolean;
  enabled: boolean;
  active: boolean;
}

export interface ClusterInfo {
  name?: string;
  quorate?: boolean;
  nodesOnline: number;
  nodesTotal: number;
}

export interface ProxmoxResources {
  cluster: ClusterInfo;
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
  storage: ProxmoxStorage[];
  generatedAt: string;
}

/** Health-check categories, in the spirit of Pulse "Patrol" */
export type AttentionCategory =
  | 'nodeOffline'
  | 'guestStopped'
  | 'storageFull'
  | 'storageInactive'
  | 'nodeMemoryHigh'
  | 'guestMemoryHigh';

export interface AttentionItem {
  category: AttentionCategory;
  severity: 'high' | 'warning';
  /** Human-readable subject, e.g. "pve11" or "dhis2-ento (LXC 190)" */
  subject: string;
  node: string;
  detail: string;
}

export const CATEGORY_INFO: Record<
  AttentionCategory,
  { label: string; description: string }
> = {
  nodeOffline: {
    label: 'Node offline',
    description: 'A cluster node is not online.',
  },
  storageFull: {
    label: 'Storage almost full',
    description: 'A storage pool is above the capacity threshold.',
  },
  storageInactive: {
    label: 'Storage inactive',
    description: 'A storage pool is enabled but not active on its node.',
  },
  nodeMemoryHigh: {
    label: 'Node memory high',
    description: 'A node is using most of its memory.',
  },
  guestMemoryHigh: {
    label: 'Guest memory high',
    description: 'A running guest is near its memory limit.',
  },
  guestStopped: {
    label: 'Guest stopped',
    description: 'A non-template guest is stopped.',
  },
};
