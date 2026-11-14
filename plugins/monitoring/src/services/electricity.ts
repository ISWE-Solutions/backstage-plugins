import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { byLabel, prometheusBase, promQuery, Sample } from './prometheus';
import {
  GuestUsage,
  HOURS_PER_MONTH,
  Period,
  periodMinutes,
} from './costModel';

/*
 * Electricity of the Proxmox nodes and its share per guest, shown beside (not added to) the guests'
 * costs, since the hosting fee may already include power.
 *
 * Per node, over the period:
 *   energy (kWh)   the server's draw at the wall (BMC), node_power_watts, every minute
 *   idle (W)       estimated as the 5th percentile of the draw over the period
 *   dynamic        energy above idle: shared out by the guests' CPU core-hours on that node
 *   baseline       idle energy: shared out by the guests' memory GiB-hours on that node
 *   at the meter   IT energy x PUE (cooling and power distribution), when configured
 *   cost           energy at the meter x tariff
 *
 * Data: node_* from deploy/observability/platform/node-power.py (BMC sensors over IPMI and Intel RAPL).
 */

export interface ElectricityConfig {
  /** price of a kWh, in the cost currency; without it only energy is shown */
  tariffPerKwh?: number;
  /** power usage effectiveness of the room: facility energy / IT energy (1 = not counted) */
  pue: number;
  /** grid emission factor, kg CO2 per kWh (optional) */
  co2KgPerKwh?: number;
}

export function readElectricityConfig(configApi: ConfigApi): ElectricityConfig {
  const c = configApi.getOptionalConfig('monitoring.costs.electricity');
  return {
    tariffPerKwh: c?.getOptionalNumber('tariffPerKwh'),
    pue: c?.getOptionalNumber('pue') ?? 1,
    co2KgPerKwh: c?.getOptionalNumber('co2KgPerKwh'),
  };
}

export interface NodePower {
  node: string;
  /** hours of the period with power readings */
  coveredHours: number;
  averageW: number;
  peakW: number;
  idleW: number;
  /** IT energy over the covered hours */
  kwh: number;
  /** CPU packages and DRAM (RAPL), average */
  cpuMemoryW?: number;
  /** AC input per power supply, now (0 = no input) */
  psuVolts: Record<string, number>;
  inletC?: number;
}

const STEP = 5;
const sub = (expr: string, minutes: number) =>
  `(${expr})[${minutes}m:${STEP}m]`;

export async function loadNodePower(
  apis: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    configApi: ConfigApi;
  },
  period: Period,
): Promise<NodePower[]> {
  const base = await prometheusBase(apis.discoveryApi, apis.configApi);
  const minutes = periodMinutes(period);
  const w = 'max by (node) (last_over_time(node_power_watts[3m]))';
  const queries: Record<string, string> = {
    steps: `count_over_time(${sub(w, minutes)})`,
    avg: `avg_over_time(${sub(w, minutes)})`,
    peak: `max_over_time(${sub(w, minutes)})`,
    idle: `quantile_over_time(0.05, ${sub(w, minutes)})`,
    rapl: `avg_over_time(${sub(
      'sum by (node) (rate(node_rapl_energy_joules[5m]))',
      minutes,
    )})`,
    psu: 'max by (node, psu) (last_over_time(node_psu_input_volts[10m]))',
    inlet:
      'max by (node) (last_over_time(node_inlet_temperature_celsius[10m]))',
  };
  const keys = Object.keys(queries);
  const results = await Promise.all(
    keys.map(k => promQuery(apis.fetchApi, base, queries[k])),
  );
  const r: Record<string, Sample[]> = {};
  keys.forEach((k, i) => (r[k] = results[i]));
  return buildNodePower(r);
}

export function buildNodePower(r: Record<string, Sample[]>): NodePower[] {
  const v = (k: string) => byLabel(r[k] ?? [], 'node');
  const [steps, avg, peak, idle, rapl, inlet] = [
    'steps',
    'avg',
    'peak',
    'idle',
    'rapl',
    'inlet',
  ].map(v);
  const psu = new Map<string, Record<string, number>>();
  for (const s of r.psu ?? []) {
    const m = psu.get(s.metric.node) ?? {};
    m[s.metric.psu] = Number(s.value[1]);
    psu.set(s.metric.node, m);
  }
  return [...steps.keys()].sort().map(node => {
    const coveredHours = ((steps.get(node) ?? 0) * STEP) / 60;
    const averageW = avg.get(node) ?? 0;
    return {
      node,
      coveredHours,
      averageW,
      peakW: peak.get(node) ?? averageW,
      idleW: Math.min(idle.get(node) ?? averageW, averageW),
      kwh: (averageW * coveredHours) / 1000,
      cpuMemoryW: rapl.get(node),
      psuVolts: psu.get(node) ?? {},
      inletC: inlet.get(node),
    };
  });
}

export interface GuestEnergy {
  vmid: string;
  name: string;
  node: string;
  env: string;
  /** IT energy over the node's covered hours */
  kwh: number;
  /** per month, at the meter (x PUE) */
  monthlyKwh: number;
  monthlyCost?: number;
}

export interface ElectricityResult {
  config: ElectricityConfig;
  nodes: (NodePower & {
    monthlyKwh: number;
    monthlyCost?: number;
    unassignedKwh: number;
  })[];
  guests: GuestEnergy[];
  totals: {
    averageW: number;
    kwh: number;
    /** at the meter, per month */
    monthlyKwh: number;
    monthlyCost?: number;
    monthlyCo2Kg?: number;
  };
  /** power supplies with no AC input now: "pve03 PSU 1" */
  psuWithoutInput: string[];
}

/**
 * Shares each node's energy out over the guests on it: the energy above idle by CPU core-hours, the
 * idle energy by memory GiB-hours (both from the cost model's usage over the same period).
 */
export function computeElectricity(
  nodes: NodePower[],
  guests: GuestUsage[],
  config: ElectricityConfig,
): ElectricityResult {
  const perMonth = (n: NodePower) =>
    n.coveredHours > 0 ? HOURS_PER_MONTH / n.coveredHours : 0;
  const out: GuestEnergy[] = [];
  const nodeRows = nodes.map(n => {
    const onNode = guests.filter(g => g.node === n.node && g.runningHours > 0);
    const cpu = onNode.reduce((s, g) => s + g.cpuUsedCoreHours, 0);
    const mem = onNode.reduce((s, g) => s + g.memoryUsedGbHours, 0);
    const idleKwh = Math.min(n.kwh, (n.idleW * n.coveredHours) / 1000);
    const dynamicKwh = n.kwh - idleKwh;
    let assigned = 0;
    for (const g of onNode) {
      const kwh =
        (cpu > 0 ? (dynamicKwh * g.cpuUsedCoreHours) / cpu : 0) +
        (mem > 0 ? (idleKwh * g.memoryUsedGbHours) / mem : 0);
      assigned += kwh;
      const monthlyKwh = kwh * perMonth(n) * config.pue;
      out.push({
        vmid: g.vmid,
        name: g.name,
        node: n.node,
        env: g.env,
        kwh,
        monthlyKwh,
        monthlyCost:
          config.tariffPerKwh !== undefined
            ? monthlyKwh * config.tariffPerKwh
            : undefined,
      });
    }
    const monthlyKwh = n.kwh * perMonth(n) * config.pue;
    return {
      ...n,
      monthlyKwh,
      monthlyCost:
        config.tariffPerKwh !== undefined
          ? monthlyKwh * config.tariffPerKwh
          : undefined,
      unassignedKwh: Math.max(0, n.kwh - assigned),
    };
  });
  const monthlyKwh = nodeRows.reduce((s, n) => s + n.monthlyKwh, 0);
  return {
    config,
    nodes: nodeRows,
    guests: out.sort((a, b) => b.monthlyKwh - a.monthlyKwh),
    totals: {
      averageW: nodes.reduce((s, n) => s + n.averageW, 0),
      kwh: nodes.reduce((s, n) => s + n.kwh, 0),
      monthlyKwh,
      monthlyCost:
        config.tariffPerKwh !== undefined
          ? monthlyKwh * config.tariffPerKwh
          : undefined,
      monthlyCo2Kg:
        config.co2KgPerKwh !== undefined
          ? monthlyKwh * config.co2KgPerKwh
          : undefined,
    },
    psuWithoutInput: nodes.flatMap(n =>
      Object.entries(n.psuVolts)
        .filter(([, volts]) => volts < 100)
        .map(([psu]) => `${n.node} PSU ${psu}`),
    ),
  };
}
