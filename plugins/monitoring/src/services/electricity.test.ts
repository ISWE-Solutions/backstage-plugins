import { buildNodePower, computeElectricity } from './electricity';
import { GuestUsage } from './costModel';

const s = (metric: Record<string, string>, value: number) => ({
  metric,
  value: [0, String(value)] as [number, string],
});
const guest = (
  vmid: string,
  node: string,
  cpu: number,
  mem: number,
  running = 10,
): GuestUsage =>
  ({
    vmid,
    name: `g${vmid}`,
    node,
    kind: 'ct',
    env: 'prod',
    tags: '',
    exists: true,
    runningHours: running,
    cpuUsedCoreHours: cpu,
    cpuAllocatedCoreHours: 0,
    memoryUsedGbHours: mem,
    memoryAllocatedGbHours: 0,
    diskGb: 0,
    networkInGb: 0,
    networkOutGb: 0,
    diskReadGb: 0,
    diskWrittenGb: 0,
    backupGb: 0,
  } as GuestUsage);

// pve03: 10 hours of readings at 250 W on average, idle 150 W; PSU 1 without input
const nodes = () =>
  buildNodePower({
    steps: [s({ node: 'pve03' }, 120)],
    avg: [s({ node: 'pve03' }, 250)],
    peak: [s({ node: 'pve03' }, 300)],
    idle: [s({ node: 'pve03' }, 150)],
    rapl: [s({ node: 'pve03' }, 160)],
    psu: [
      s({ node: 'pve03', psu: '1' }, 0),
      s({ node: 'pve03', psu: '2' }, 228),
    ],
    inlet: [s({ node: 'pve03' }, 19)],
  });

describe('electricity', () => {
  it('reads node power', () => {
    const [n] = nodes();
    expect(n).toMatchObject({
      node: 'pve03',
      coveredHours: 10,
      averageW: 250,
      idleW: 150,
      kwh: 2.5,
      cpuMemoryW: 160,
    });
    expect(n.psuVolts).toEqual({ '1': 0, '2': 228 });
  });

  it('shares a node out: above idle by CPU, idle by memory', () => {
    // dynamic 1.0 kWh: a has 3/4 of the CPU; idle 1.5 kWh: a has 1/3 of the memory
    const r = computeElectricity(
      nodes(),
      [
        guest('a', 'pve03', 3, 10),
        guest('b', 'pve03', 1, 20),
        guest('c', 'pve03', 5, 5, 0),
      ],
      { pue: 1 },
    );
    const a = r.guests.find(g => g.vmid === 'a')!;
    expect(a.kwh).toBeCloseTo(0.75 + 0.5);
    expect(r.guests.reduce((t, g) => t + g.kwh, 0)).toBeCloseTo(2.5); // all of it
    expect(r.guests.find(g => g.vmid === 'c')).toBeUndefined(); // not running
    expect(r.nodes[0].unassignedKwh).toBeCloseTo(0);
    expect(r.psuWithoutInput).toEqual(['pve03 PSU 1']);
    expect(r.totals.monthlyCost).toBeUndefined();
  });

  it('applies PUE, tariff and CO2 per month', () => {
    const r = computeElectricity(nodes(), [guest('a', 'pve03', 1, 1)], {
      pue: 1.5,
      tariffPerKwh: 3,
      co2KgPerKwh: 0.1,
    });
    // 250 W for a 730-hour month = 182.5 kWh, x1.5 at the meter
    expect(r.totals.monthlyKwh).toBeCloseTo(273.75);
    expect(r.totals.monthlyCost).toBeCloseTo(821.25);
    expect(r.totals.monthlyCo2Kg).toBeCloseTo(27.375);
    expect(r.guests[0].monthlyKwh).toBeCloseTo(273.75);
  });
});
