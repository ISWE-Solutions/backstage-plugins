import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  CatalogApi,
  CATALOG_FILTER_EXISTS,
} from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  byLabel,
  prometheusBase,
  promQuery,
  Sample,
  single,
} from './prometheus';
import { GUESTS_ANNOTATION } from './liveHealth';

/*
 * Cost model for Proxmox guests (containers and VMs).
 *
 * Every guest is charged for what it takes from five resource pools, over a period:
 *
 *   CPU      core-hours: cores actually used, optionally blended with cores allotted
 *   memory   GiB-hours while running: containers a blend of the limit and the use; VMs their full
 *            RAM (it is committed on the host while they run)
 *   storage  GiB-hours of allotted disk, running or stopped (a stopped guest still holds its disk)
 *   network  GiB received and sent
 *   backup   the guest's share of pbs01's real use (shared out by the size of each guest's newest backup)
 *   + an optional fixed fee per guest per month
 *
 * Prices come from either
 *   - cost recovery: monthlyInfrastructureCost split across the pools, divided by each pool's capacity
 *     (cores, RAM and thin pools of the nodes, pbs01), so capacity nobody uses shows as unused; the
 *     network pool is shared out by traffic, so it is always fully recovered; or
 *   - a price list: explicit rates, each overriding the derived one.
 *
 * Data: pve_guest_* from deploy/observability/platform (pve-guest-usage.py every minute, pve-metrics.py
 * every 5 minutes) in Prometheus, which keeps 30 days.
 */

export const HOURS_PER_MONTH = 730;
const GIB = 1024 ** 3;
const STEP_MINUTES = 5;

export type Basis = 'used' | 'allocated' | 'blend';
export type Resource =
  | 'cpu'
  | 'memory'
  | 'storage'
  | 'network'
  | 'backup'
  | 'fixed';
export const RESOURCES: Resource[] = [
  'cpu',
  'memory',
  'storage',
  'network',
  'backup',
  'fixed',
];

export interface Rates {
  /** per core used for a month */
  cpuCoreMonth: number;
  /** per GiB of memory for a month */
  memoryGbMonth: number;
  /** per GiB of allotted disk for a month */
  storageGbMonth: number;
  /** per GiB of network traffic */
  networkGb: number;
  /** per GiB of pbs01 for a month */
  backupGbMonth: number;
  /** fixed fee per guest per month */
  guestMonth: number;
}

export interface CostConfig {
  currency: string;
  /** what the infrastructure costs per month in total, when costs are recovered from it */
  monthlyInfrastructureCost?: number;
  split: Record<'cpu' | 'memory' | 'storage' | 'network' | 'backup', number>;
  /** explicit rates; they override the derived ones */
  rates: Partial<Rates>;
  cpuBasis: Basis;
  /** weight of the allotted cores when cpuBasis is blend (0..1) */
  cpuAllocatedWeight: number;
  memoryBasis: Basis;
  /** weight of the memory limit when memoryBasis is blend (0..1) */
  memoryAllocatedWeight: number;
  /** VMs: a running VM's RAM is committed on the host, so by default it is charged in full */
  vmMemoryBasis: Basis;
  networkDirection: 'both' | 'out';
  /** guests whose cost is shared services overhead: env tag, or name pattern */
  sharedEnvironments: string[];
  sharedNamePattern?: string;
  /** true when nothing is configured and the built-in example rates are in use */
  example: boolean;
}

/** Example rates for when nothing is configured: placeholders, not ISWE's real costs. */
export const EXAMPLE_RATES: Rates = {
  cpuCoreMonth: 15,
  memoryGbMonth: 4,
  storageGbMonth: 0.1,
  networkGb: 0.05,
  backupGbMonth: 0.03,
  guestMonth: 0,
};

const DEFAULT_SPLIT = {
  cpu: 0.35,
  memory: 0.35,
  storage: 0.15,
  network: 0.1,
  backup: 0.05,
};

export function readCostConfig(configApi: ConfigApi): CostConfig {
  const c = configApi.getOptionalConfig('monitoring.costs');
  const num = (key: string) => c?.getOptionalNumber(key);
  const rates: Partial<Rates> = {};
  for (const k of Object.keys(EXAMPLE_RATES) as (keyof Rates)[]) {
    const v = num(`rates.${k}`);
    if (v !== undefined) rates[k] = v;
  }
  const monthly = num('monthlyInfrastructureCost');
  const split = { ...DEFAULT_SPLIT };
  for (const k of Object.keys(
    DEFAULT_SPLIT,
  ) as (keyof typeof DEFAULT_SPLIT)[]) {
    const v = num(`split.${k}`);
    if (v !== undefined) split[k] = v;
  }
  const basis = (key: string, d: Basis): Basis => {
    const v = c?.getOptionalString(key);
    return v === 'used' || v === 'allocated' || v === 'blend' ? v : d;
  };
  const example = monthly === undefined && Object.keys(rates).length === 0;
  return {
    currency: c?.getOptionalString('currency') ?? 'USD',
    monthlyInfrastructureCost: monthly,
    split,
    rates: example ? { ...EXAMPLE_RATES } : rates,
    cpuBasis: basis('cpuBasis', 'used'),
    cpuAllocatedWeight: num('cpuAllocatedWeight') ?? 0.25,
    memoryBasis: basis('memoryBasis', 'blend'),
    memoryAllocatedWeight: num('memoryAllocatedWeight') ?? 0.5,
    vmMemoryBasis: basis('vmMemoryBasis', 'allocated'),
    networkDirection:
      c?.getOptionalString('networkDirection') === 'out' ? 'out' : 'both',
    sharedEnvironments: c?.getOptionalStringArray('sharedEnvironments') ?? [
      'shared',
    ],
    sharedNamePattern:
      c?.getOptionalString('sharedNamePattern') ??
      '^(shared-|proxy$|pg0[0-9]$)',
    example,
  };
}

// ------------------------------------------------------------------ inputs

export type Period = '24h' | '7d' | '30d' | 'mtd';
export const PERIODS: { value: Period; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'mtd', label: 'Month to date' },
];

/** The window in whole minutes (a multiple of the 5-minute step), for PromQL. */
export function periodMinutes(period: Period, now: Date = new Date()): number {
  switch (period) {
    case '24h':
      return 24 * 60;
    case '7d':
      return 7 * 24 * 60;
    case '30d':
      return 30 * 24 * 60;
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const m = Math.floor((now.getTime() - start.getTime()) / 60000);
      return Math.max(STEP_MINUTES, m - (m % STEP_MINUTES));
    }
  }
}

/** One guest's usage over the period. */
export interface GuestUsage {
  vmid: string;
  name: string;
  node: string;
  kind: string;
  env: string;
  tags: string;
  /** false when it no longer exists (it is billed for the time it ran) */
  exists: boolean;
  runningHours: number;
  cpuUsedCoreHours: number;
  cpuAllocatedCoreHours: number;
  memoryUsedGbHours: number;
  memoryAllocatedGbHours: number;
  /** allotted disk now, GiB */
  diskGb: number;
  /** disk in use now (containers only), GiB */
  diskUsedGb?: number;
  networkInGb: number;
  networkOutGb: number;
  diskReadGb: number;
  diskWrittenGb: number;
  /** newest backup, GiB (logical) */
  backupGb: number;
  /** now, for right-sizing: allotted cores and memory limit (GiB) */
  cores?: number;
  memoryLimitGb?: number;
}

export interface Capacity {
  cores: number;
  memoryGb: number;
  storageGb: number;
  backupTotalGb: number;
  backupUsedGb: number;
}

export interface CostInputs {
  /** hours of the period that have usage data (Prometheus keeps 30 days; per-minute data from 19 Oct 2026) */
  coveredHours: number;
  periodHours: number;
  guests: GuestUsage[];
  capacity: Capacity;
}

const sub = (expr: string, minutes: number) =>
  `(${expr})[${minutes}m:${STEP_MINUTES}m]`;
const PER_STEP_HOURS = STEP_MINUTES / 60;

export async function loadCostInputs(
  apis: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    configApi: ConfigApi;
  },
  period: Period,
): Promise<CostInputs> {
  const base = await prometheusBase(apis.discoveryApi, apis.configApi);
  const minutes = periodMinutes(period);
  const w = `${minutes}m`;
  const q = (expr: string) => promQuery(apis.fetchApi, base, expr);
  // running = the per-minute series exist (pve-guest-usage.py only sends them for running guests)
  const running = 'max by (vmid) (pve_guest_cpu_cores)';
  const memLimit =
    'max by (vmid) (last_over_time(pve_guest_memory_max_bytes[15m]))';
  const queries: Record<string, string> = {
    info: `max by (vmid, name, node, kind, env, tags) (last_over_time(pve_guest_info[${w}]))`,
    infoNow:
      'max by (vmid, name, node, kind, env, tags) (last_over_time(pve_guest_info[10m]))',
    runningSteps: `count_over_time(${sub(running, minutes)})`,
    cpuUsed: `sum_over_time(${sub(
      'max by (vmid) (pve_guest_cpu_used_cores)',
      minutes,
    )})`,
    cpuAllocated: `sum_over_time(${sub(running, minutes)})`,
    memUsed: `sum_over_time(${sub(
      'max by (vmid) (pve_guest_memory_used_bytes)',
      minutes,
    )})`,
    memAllocated: `sum_over_time(${sub(
      `${memLimit} and on (vmid) ${running}`,
      minutes,
    )})`,
    disk: 'max by (vmid) (last_over_time(pve_guest_disk_max_bytes[15m]))',
    diskUsed: 'max by (vmid) (last_over_time(pve_guest_disk_used_bytes[15m]))',
    netIn: `max by (vmid) (increase(pve_guest_net_in_bytes_total[${w}]))`,
    netOut: `max by (vmid) (increase(pve_guest_net_out_bytes_total[${w}]))`,
    diskRead: `max by (vmid) (increase(pve_guest_disk_read_bytes_total[${w}]))`,
    diskWritten: `max by (vmid) (increase(pve_guest_disk_written_bytes_total[${w}]))`,
    backup: 'max by (vmid) (last_over_time(pve_guest_backup_bytes[2h]))',
    coresNow: 'max by (vmid) (last_over_time(pve_guest_cpu_cores[10m]))',
    memLimitNow: memLimit,
    coveredSteps: `count_over_time(${sub(
      'count(pve_guest_cpu_cores)',
      minutes,
    )})`,
    capCores: 'sum(max by (node) (last_over_time(pve_node_cpu_cores[15m])))',
    capMemory:
      'sum(max by (node) (last_over_time(pve_node_memory_total_bytes[15m])))',
    capStorage:
      'sum(max by (node) (last_over_time(pve_storage_size_bytes{storage="local-lvm"}[15m])))',
    capBackup: 'max(last_over_time(pve_pbs_total_bytes[15m]))',
    usedBackup: 'max(last_over_time(pve_pbs_used_bytes[15m]))',
  };
  const keys = Object.keys(queries);
  const results = await Promise.all(keys.map(k => q(queries[k])));
  const r: Record<string, Sample[]> = {};
  keys.forEach((k, i) => (r[k] = results[i]));
  return buildInputs(r, minutes);
}

/** Turns the query results into usage per guest (separate from the queries, for testing). */
export function buildInputs(
  r: Record<string, Sample[]>,
  minutes: number,
): CostInputs {
  const v = (k: string) => byLabel(r[k] ?? [], 'vmid');
  const [
    runningSteps,
    cpuUsed,
    cpuAlloc,
    memUsed,
    memAlloc,
    disk,
    diskUsed,
    netIn,
    netOut,
    dRead,
    dWritten,
    backup,
    coresNow,
    memNow,
  ] = [
    'runningSteps',
    'cpuUsed',
    'cpuAllocated',
    'memUsed',
    'memAllocated',
    'disk',
    'diskUsed',
    'netIn',
    'netOut',
    'diskRead',
    'diskWritten',
    'backup',
    'coresNow',
    'memLimitNow',
  ].map(v);
  const now = new Set((r.infoNow ?? []).map(s => s.metric.vmid));
  // one row per guest: the current labels when it still exists (a migrated guest has two series)
  const info = new Map<string, Record<string, string>>();
  for (const s of [...(r.info ?? []), ...(r.infoNow ?? [])])
    info.set(s.metric.vmid, s.metric);
  const gb = (x?: number) => (x ?? 0) / GIB;
  const guests: GuestUsage[] = [...info.values()].map(m => {
    const id = m.vmid;
    return {
      vmid: id,
      name: m.name ?? id,
      node: m.node ?? '',
      kind: m.kind ?? '',
      env: m.env ?? 'untagged',
      tags: m.tags ?? '',
      exists: now.has(id),
      runningHours: (runningSteps.get(id) ?? 0) * PER_STEP_HOURS,
      cpuUsedCoreHours: (cpuUsed.get(id) ?? 0) * PER_STEP_HOURS,
      cpuAllocatedCoreHours: (cpuAlloc.get(id) ?? 0) * PER_STEP_HOURS,
      memoryUsedGbHours: gb(memUsed.get(id)) * PER_STEP_HOURS,
      memoryAllocatedGbHours: gb(memAlloc.get(id)) * PER_STEP_HOURS,
      diskGb: now.has(id) ? gb(disk.get(id)) : 0,
      diskUsedGb: diskUsed.has(id) ? gb(diskUsed.get(id)) : undefined,
      networkInGb: gb(netIn.get(id)),
      networkOutGb: gb(netOut.get(id)),
      diskReadGb: gb(dRead.get(id)),
      diskWrittenGb: gb(dWritten.get(id)),
      backupGb: now.has(id) ? gb(backup.get(id)) : 0,
      cores: coresNow.get(id),
      memoryLimitGb: memNow.has(id) ? gb(memNow.get(id)) : undefined,
    };
  });
  return {
    periodHours: minutes / 60,
    coveredHours: Math.min(
      minutes / 60,
      (single(r.coveredSteps ?? []) ?? 0) * PER_STEP_HOURS,
    ),
    guests,
    capacity: {
      cores: single(r.capCores ?? []) ?? 0,
      memoryGb: gb(single(r.capMemory ?? [])),
      storageGb: gb(single(r.capStorage ?? [])),
      backupTotalGb: gb(single(r.capBackup ?? [])),
      backupUsedGb: gb(single(r.usedBackup ?? [])),
    },
  };
}

// --------------------------------------------------------------- the model

export interface GuestCost extends GuestUsage {
  shared: boolean;
  /** billed quantities */
  billed: {
    cpuCoreHours: number;
    memoryGbHours: number;
    storageGbHours: number;
    networkGb: number;
    backupGb: number;
  };
  cost: Record<Resource, number>;
  /** cost of shared services spread onto this guest (when spreading) */
  sharedOverhead: number;
  total: number;
  /** total scaled to a 730-hour month */
  monthly: number;
}

export interface CostResult {
  config: CostConfig;
  rates: Rates;
  /** where each rate came from */
  rateSource: Record<keyof Rates, 'configured' | 'derived' | 'example'>;
  /** average demand on the billing basis, against capacity (overcommit when above 1) */
  demand: { cores: number; memoryGb: number; storageGb: number };
  periodHours: number;
  coveredHours: number;
  guests: GuestCost[];
  total: number;
  monthly: number;
  byResource: Record<Resource, number>;
  sharedTotal: number;
  /** cost recovery: the infrastructure's cost over the covered hours, and what guests didn't take up */
  infrastructureCost?: number;
  unusedCapacityCost?: number;
  capacity: Capacity;
}

/** The weight of the allotted amount on a basis: 0 used, 1 allocated, or the blend weight. */
export function allocatedWeight(basis: Basis, blendWeight: number): number {
  if (basis === 'used') return 0;
  if (basis === 'allocated') return 1;
  return blendWeight;
}

const blend = (
  basis: Basis,
  used: number,
  allocated: number,
  weight: number,
) => {
  const w = allocatedWeight(basis, weight);
  return (1 - w) * used + w * allocated;
};

export function computeCosts(
  inputs: CostInputs,
  config: CostConfig,
  options: { spreadShared: boolean } = { spreadShared: false },
): CostResult {
  const { guests, capacity, coveredHours } = inputs;
  const months = coveredHours / HOURS_PER_MONTH;
  const sharedRx = config.sharedNamePattern
    ? new RegExp(config.sharedNamePattern, 'i')
    : undefined;
  const billedOf = (g: GuestUsage) => ({
    cpuCoreHours: blend(
      config.cpuBasis,
      g.cpuUsedCoreHours,
      g.cpuAllocatedCoreHours,
      config.cpuAllocatedWeight,
    ),
    memoryGbHours: blend(
      g.kind === 'vm' ? config.vmMemoryBasis : config.memoryBasis,
      g.memoryUsedGbHours,
      g.memoryAllocatedGbHours,
      config.memoryAllocatedWeight,
    ),
    storageGbHours: g.diskGb * coveredHours,
    networkGb:
      config.networkDirection === 'out'
        ? g.networkOutGb
        : g.networkInGb + g.networkOutGb,
    backupGb: g.backupGb,
  });
  const billed = guests.map(billedOf);
  const totalNetworkGb = billed.reduce((s, b) => s + b.networkGb, 0);
  const totalBackupGb = billed.reduce((s, b) => s + b.backupGb, 0);

  // rates: configured, else derived from the monthly cost and capacity, else the examples
  const m = config.monthlyInfrastructureCost;
  // What the guests take on average, on the billing basis. The cluster is overcommitted (allotted cores,
  // memory limits and thin disks exceed the hardware), so each rate divides the pool's cost by the larger
  // of its capacity and what is billed: a pool never recovers more than its share of the monthly cost.
  const sum = (f: (b: (typeof billed)[number]) => number) =>
    billed.reduce((s, b) => s + f(b), 0);
  const demand = {
    cores: coveredHours > 0 ? sum(b => b.cpuCoreHours) / coveredHours : 0,
    memoryGb: coveredHours > 0 ? sum(b => b.memoryGbHours) / coveredHours : 0,
    storageGb: coveredHours > 0 ? sum(b => b.storageGbHours) / coveredHours : 0,
  };
  const derived: Partial<Rates> = {};
  if (m !== undefined) {
    const per = (share: number, cap: number, used: number) => {
      const d = Math.max(cap, used);
      return d > 0 ? (m * share) / d : undefined;
    };
    derived.cpuCoreMonth = per(config.split.cpu, capacity.cores, demand.cores);
    derived.memoryGbMonth = per(
      config.split.memory,
      capacity.memoryGb,
      demand.memoryGb,
    );
    derived.storageGbMonth = per(
      config.split.storage,
      capacity.storageGb,
      demand.storageGb,
    );
    derived.backupGbMonth = per(config.split.backup, capacity.backupTotalGb, 0);
    // network: the pool is shared out by traffic, so its rate depends on the period's traffic
    if (totalNetworkGb > 0 && months > 0)
      derived.networkGb = (m * config.split.network * months) / totalNetworkGb;
    derived.guestMonth = 0;
  }
  const rates = {} as Rates;
  const rateSource = {} as CostResult['rateSource'];
  for (const k of Object.keys(EXAMPLE_RATES) as (keyof Rates)[]) {
    if (config.rates[k] !== undefined) {
      rates[k] = config.rates[k] as number;
      rateSource[k] = config.example ? 'example' : 'configured';
    } else if (derived[k] !== undefined) {
      rates[k] = derived[k] as number;
      rateSource[k] = 'derived';
    } else {
      rates[k] = 0;
      rateSource[k] = 'configured';
    }
  }

  // backups: pbs01 deduplicates, so share its real use out by each guest's newest-backup size
  const backupScale =
    totalBackupGb > 0 && capacity.backupUsedGb > 0
      ? capacity.backupUsedGb / totalBackupGb
      : 1;

  const rows: GuestCost[] = guests.map((g, i) => {
    const b = billed[i];
    const cost: Record<Resource, number> = {
      cpu: (b.cpuCoreHours / HOURS_PER_MONTH) * rates.cpuCoreMonth,
      memory: (b.memoryGbHours / HOURS_PER_MONTH) * rates.memoryGbMonth,
      storage: (b.storageGbHours / HOURS_PER_MONTH) * rates.storageGbMonth,
      network: b.networkGb * rates.networkGb,
      backup: b.backupGb * backupScale * months * rates.backupGbMonth,
      fixed: g.exists
        ? months * rates.guestMonth
        : (g.runningHours / HOURS_PER_MONTH) * rates.guestMonth,
    };
    const total = RESOURCES.reduce((s, k) => s + cost[k], 0);
    const shared =
      config.sharedEnvironments.includes(g.env) ||
      (sharedRx?.test(g.name) ?? false);
    return {
      ...g,
      shared,
      billed: b,
      cost,
      sharedOverhead: 0,
      total,
      monthly: 0,
    };
  });

  const sharedTotal = rows
    .filter(r => r.shared)
    .reduce((s, r) => s + r.total, 0);
  if (options.spreadShared && sharedTotal > 0) {
    const direct = rows.filter(r => !r.shared).reduce((s, r) => s + r.total, 0);
    for (const r of rows) {
      if (!r.shared && direct > 0)
        r.sharedOverhead = (sharedTotal * r.total) / direct;
    }
  }
  const scale = coveredHours > 0 ? HOURS_PER_MONTH / coveredHours : 0;
  for (const r of rows) {
    if (options.spreadShared && r.shared) {
      r.sharedOverhead = -r.total; // moved onto the others
    }
    r.total += r.sharedOverhead;
    r.monthly = r.total * scale;
  }

  const byResource = Object.fromEntries(
    RESOURCES.map(k => [k, rows.reduce((s, r) => s + r.cost[k], 0)]),
  ) as Record<Resource, number>;
  const total = rows.reduce((s, r) => s + r.total, 0);
  const infrastructureCost = m !== undefined ? m * months : undefined;
  return {
    config,
    rates,
    rateSource,
    demand,
    periodHours: inputs.periodHours,
    coveredHours,
    guests: rows.sort((a, b) => b.total - a.total),
    total,
    monthly: total * scale,
    byResource,
    sharedTotal,
    infrastructureCost,
    unusedCapacityCost:
      infrastructureCost !== undefined
        ? Math.max(0, infrastructureCost - total)
        : undefined,
    capacity,
  };
}

// ------------------------------------------------------- grouping, hints

export interface GroupCost {
  key: string;
  guests: number;
  total: number;
  monthly: number;
  byResource: Record<Resource, number>;
}

export function groupBy(
  rows: GuestCost[],
  keyOf: (r: GuestCost) => string,
  scale: number,
): GroupCost[] {
  const m = new Map<string, GroupCost>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? {
      key: k,
      guests: 0,
      total: 0,
      monthly: 0,
      byResource: Object.fromEntries(RESOURCES.map(x => [x, 0])) as Record<
        Resource,
        number
      >,
    };
    g.guests += 1;
    g.total += r.total;
    g.monthly += r.total * scale;
    for (const x of RESOURCES) g.byResource[x] += r.cost[x];
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/**
 * Cost per catalog Component and System: each Component's iswesolutions.com/proxmox-guests names its
 * guests; a guest named by several Components is split between them evenly.
 */
export async function costByCatalog(
  catalogApi: CatalogApi,
  result: CostResult,
): Promise<{
  components: GroupCost[];
  systems: GroupCost[];
  unassigned: number;
}> {
  const { items } = await catalogApi.getEntities({
    filter: {
      kind: 'Component',
      [`metadata.annotations.${GUESTS_ANNOTATION}`]: CATALOG_FILTER_EXISTS,
    },
    fields: [
      'kind',
      'metadata.name',
      'metadata.namespace',
      'metadata.title',
      'metadata.annotations',
      'spec.system',
    ],
  });
  const owners = new Map<
    string,
    { ref: string; title: string; system: string }[]
  >();
  for (const e of items) {
    const names = (e.metadata.annotations?.[GUESTS_ANNOTATION] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const n of names) {
      const list = owners.get(n) ?? [];
      list.push({
        ref: stringifyEntityRef(e),
        title: e.metadata.title ?? e.metadata.name,
        system: (e.spec?.system as string | undefined) ?? '(no system)',
      });
      owners.set(n, list);
    }
  }
  const scale =
    result.coveredHours > 0 ? HOURS_PER_MONTH / result.coveredHours : 0;
  const comp = new Map<string, GroupCost>();
  const sys = new Map<string, GroupCost>();
  let unassigned = 0;
  const add = (
    m: Map<string, GroupCost>,
    key: string,
    r: GuestCost,
    share: number,
  ) => {
    const g = m.get(key) ?? {
      key,
      guests: 0,
      total: 0,
      monthly: 0,
      byResource: Object.fromEntries(RESOURCES.map(x => [x, 0])) as Record<
        Resource,
        number
      >,
    };
    g.guests += share;
    g.total += r.total * share;
    g.monthly += r.total * share * scale;
    for (const x of RESOURCES) g.byResource[x] += r.cost[x] * share;
    m.set(key, g);
  };
  for (const r of result.guests) {
    const o = owners.get(r.name);
    if (!o?.length) {
      unassigned += r.total;
      continue;
    }
    for (const x of o) {
      add(comp, x.title, r, 1 / o.length);
      add(sys, x.system, r, 1 / o.length);
    }
  }
  const sorted = (m: Map<string, GroupCost>) =>
    [...m.values()].sort((a, b) => b.total - a.total);
  return { components: sorted(comp), systems: sorted(sys), unassigned };
}

export interface Hint {
  vmid: string;
  name: string;
  kind: 'stopped-holding-disk' | 'memory-oversized' | 'cpu-idle';
  text: string;
  /** estimated saving per month */
  monthlySaving: number;
}

/** Right-sizing hints, with what each would save per month at the current rates. */
export function rightSizing(result: CostResult): Hint[] {
  const hints: Hint[] = [];
  const { rates, coveredHours, config } = result;
  for (const g of result.guests) {
    if (g.exists && g.runningHours === 0 && g.diskGb > 0) {
      hints.push({
        vmid: g.vmid,
        name: g.name,
        kind: 'stopped-holding-disk',
        text: `Stopped all period, holding ${g.diskGb.toFixed(0)} GiB of disk${
          g.backupGb ? ' and backups' : ''
        }`,
        monthlySaving:
          g.diskGb * rates.storageGbMonth +
          (g.cost.backup * HOURS_PER_MONTH) / Math.max(coveredHours, 1),
      });
      continue;
    }
    if (g.runningHours <= 0) continue;
    const avgMemUsed = g.memoryUsedGbHours / g.runningHours;
    const limit = g.memoryLimitGb;
    const memBasis =
      g.kind === 'vm' ? config.vmMemoryBasis : config.memoryBasis;
    // only with real usage samples: a guest without them would look like it uses nothing
    if (
      limit &&
      limit >= 2 &&
      g.memoryUsedGbHours > 0 &&
      avgMemUsed < limit * 0.25 &&
      memBasis !== 'used'
    ) {
      const target = Math.max(1, Math.ceil(avgMemUsed * 2));
      const w = memBasis === 'allocated' ? 1 : config.memoryAllocatedWeight;
      hints.push({
        vmid: g.vmid,
        name: g.name,
        kind: 'memory-oversized',
        text: `Memory limit ${limit.toFixed(
          0,
        )} GiB, average use ${avgMemUsed.toFixed(
          1,
        )} GiB: a ${target} GiB limit would do`,
        monthlySaving: (limit - target) * w * rates.memoryGbMonth,
      });
    }
    const avgCores = g.cpuUsedCoreHours / g.runningHours;
    if (g.cores && g.cores >= 4 && avgCores < g.cores * 0.02) {
      const w = allocatedWeight(config.cpuBasis, config.cpuAllocatedWeight);
      hints.push({
        vmid: g.vmid,
        name: g.name,
        kind: 'cpu-idle',
        text: `${g.cores} cores allotted, ${avgCores.toFixed(
          2,
        )} used on average`,
        monthlySaving:
          (g.cores - Math.max(1, Math.ceil(avgCores * 4))) *
          w *
          rates.cpuCoreMonth,
      });
    }
  }
  return hints.sort((a, b) => b.monthlySaving - a.monthlySaving);
}
