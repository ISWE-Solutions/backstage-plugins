import { ConfigReader } from '@backstage/config';
import {
  buildInputs,
  computeCosts,
  CostConfig,
  HOURS_PER_MONTH,
  readCostConfig,
  rightSizing,
} from './costModel';

const GIB = 1024 ** 3;
const s = (metric: Record<string, string>, value: number) => ({
  metric,
  value: [0, String(value)] as [number, string],
});
const g = (vmid: string, value: number) => s({ vmid }, value);

// A 730-hour period (one month) at 5-minute steps: 8760 steps.
const STEPS = HOURS_PER_MONTH * 12;
const MINUTES = HOURS_PER_MONTH * 60;

/** Three guests: an app running all month, a shared proxy, and a stopped VM holding 100 GiB. */
function inputs() {
  return buildInputs(
    {
      info: [
        s(
          {
            vmid: '101',
            name: 'app',
            node: 'pve01',
            kind: 'ct',
            env: 'prod',
            tags: 'prod',
          },
          1,
        ),
        s(
          {
            vmid: '102',
            name: 'proxy',
            node: 'pve01',
            kind: 'ct',
            env: 'untagged',
            tags: '',
          },
          1,
        ),
        s(
          {
            vmid: '103',
            name: 'old-vm',
            node: 'pve02',
            kind: 'vm',
            env: 'dev',
            tags: 'dev',
          },
          1,
        ),
        s(
          {
            vmid: '104',
            name: 'deleted',
            node: 'pve02',
            kind: 'ct',
            env: 'test',
            tags: '',
          },
          1,
        ),
      ],
      infoNow: [
        s(
          {
            vmid: '101',
            name: 'app',
            node: 'pve01',
            kind: 'ct',
            env: 'prod',
            tags: 'prod',
          },
          1,
        ),
        s(
          {
            vmid: '102',
            name: 'proxy',
            node: 'pve01',
            kind: 'ct',
            env: 'untagged',
            tags: '',
          },
          1,
        ),
        s(
          {
            vmid: '103',
            name: 'old-vm',
            node: 'pve02',
            kind: 'vm',
            env: 'dev',
            tags: 'dev',
          },
          1,
        ),
      ],
      runningSteps: [g('101', STEPS), g('102', STEPS), g('104', STEPS / 2)],
      // app: 2 cores used of 8; proxy: 1 of 4; deleted: 1 of 2, for half the month
      cpuUsed: [
        g('101', 2 * STEPS),
        g('102', 1 * STEPS),
        g('104', 1 * (STEPS / 2)),
      ],
      cpuAllocated: [
        g('101', 8 * STEPS),
        g('102', 4 * STEPS),
        g('104', 2 * (STEPS / 2)),
      ],
      // app: 2 GiB used of 16; proxy: 1 of 4
      memUsed: [g('101', 2 * GIB * STEPS), g('102', 1 * GIB * STEPS)],
      memAllocated: [g('101', 16 * GIB * STEPS), g('102', 4 * GIB * STEPS)],
      disk: [
        g('101', 50 * GIB),
        g('102', 10 * GIB),
        g('103', 100 * GIB),
        g('104', 20 * GIB),
      ],
      diskUsed: [g('101', 20 * GIB)],
      netIn: [g('101', 30 * GIB), g('102', 50 * GIB)],
      netOut: [g('101', 10 * GIB), g('102', 10 * GIB)],
      backup: [g('101', 40 * GIB), g('103', 60 * GIB)],
      coresNow: [g('101', 8), g('102', 4)],
      memLimitNow: [g('101', 16 * GIB), g('102', 4 * GIB), g('103', 8 * GIB)],
      coveredSteps: [s({}, STEPS)],
      capCores: [s({}, 10)],
      capMemory: [s({}, 32 * GIB)],
      capStorage: [s({}, 1000 * GIB)],
      capBackup: [s({}, 500 * GIB)],
      usedBackup: [s({}, 50 * GIB)],
    },
    MINUTES,
  );
}

const config = (c: object): CostConfig =>
  readCostConfig(new ConfigReader({ monitoring: { costs: c } }));

describe('cost model', () => {
  it('reads usage per guest, keeping guests that were deleted during the period', () => {
    const i = inputs();
    expect(i.coveredHours).toBeCloseTo(HOURS_PER_MONTH);
    const byId = Object.fromEntries(i.guests.map(x => [x.vmid, x]));
    expect(byId['101'].cpuUsedCoreHours).toBeCloseTo(2 * HOURS_PER_MONTH);
    expect(byId['101'].memoryAllocatedGbHours).toBeCloseTo(
      16 * HOURS_PER_MONTH,
    );
    expect(byId['103'].runningHours).toBe(0);
    expect(byId['103'].diskGb).toBeCloseTo(100);
    expect(byId['104'].exists).toBe(false);
    expect(byId['104'].diskGb).toBe(0); // its disk went with it
    expect(byId['104'].runningHours).toBeCloseTo(HOURS_PER_MONTH / 2);
  });

  it('charges explicit rates on the chosen bases', () => {
    const r = computeCosts(
      inputs(),
      config({
        rates: {
          cpuCoreMonth: 10,
          memoryGbMonth: 2,
          storageGbMonth: 0.1,
          networkGb: 0.01,
          backupGbMonth: 0.05,
          guestMonth: 1,
        },
      }),
    );
    const app = r.guests.find(x => x.vmid === '101')!;
    expect(app.cost.cpu).toBeCloseTo(2 * 10); // used cores
    expect(app.cost.memory).toBeCloseTo(((2 + 16) / 2) * 2); // half used, half limit
    expect(app.cost.storage).toBeCloseTo(50 * 0.1);
    expect(app.cost.network).toBeCloseTo(40 * 0.01);
    // newest backups add up to 100 GiB, pbs01 really holds 50: app's 40 counts as 20
    expect(app.cost.backup).toBeCloseTo(20 * 0.05);
    expect(app.cost.fixed).toBeCloseTo(1);
    expect(app.monthly).toBeCloseTo(app.total);
    // a stopped guest still pays for its disk
    const vm = r.guests.find(x => x.vmid === '103')!;
    expect(vm.cost.cpu).toBe(0);
    expect(vm.cost.storage).toBeCloseTo(100 * 0.1);
    expect(r.rateSource.cpuCoreMonth).toBe('configured');
  });

  it('derives rates from the monthly cost without recovering more than a pool costs', () => {
    const c = config({
      monthlyInfrastructureCost: 1000,
      split: {
        cpu: 0.4,
        memory: 0.3,
        storage: 0.2,
        network: 0.05,
        backup: 0.05,
      },
    });
    const r = computeCosts(inputs(), c);
    // CPU: 2 + 1 + 0.5 (the deleted guest, half the month) = 3.5 cores used on average of 10:
    // rate 400/10, so 35% of the CPU pool is recovered
    expect(r.rates.cpuCoreMonth).toBeCloseTo(40);
    expect(r.byResource.cpu).toBeCloseTo(3.5 * 40);
    // memory billed (2+16)/2 + (1+4)/2 = 11.5 GiB, under the 32 GiB capacity: rate by capacity
    expect(r.demand.memoryGb).toBeCloseTo(11.5);
    expect(r.rates.memoryGbMonth).toBeCloseTo(300 / 32);
    // storage: 160 GiB allotted of 1000
    expect(r.rates.storageGbMonth).toBeCloseTo(200 / 1000);
    // network is shared out by traffic: exactly its share is recovered
    expect(r.byResource.network).toBeCloseTo(50);
    expect(r.infrastructureCost).toBeCloseTo(1000);
    expect(r.total + (r.unusedCapacityCost ?? 0)).toBeCloseTo(1000);
    expect(r.rateSource.cpuCoreMonth).toBe('derived');
  });

  it('caps an overcommitted pool at full recovery', () => {
    const c = config({
      monthlyInfrastructureCost: 1000,
      memoryBasis: 'allocated',
    });
    const small = inputs();
    small.capacity.memoryGb = 8; // 20 GiB of limits on 8 GiB of RAM
    const r = computeCosts(small, c);
    expect(r.demand.memoryGb).toBeCloseTo(20);
    expect(r.byResource.memory).toBeCloseTo(1000 * c.split.memory);
  });

  it('spreads shared services over the other guests without changing the total', () => {
    const c = config({
      rates: { cpuCoreMonth: 10, memoryGbMonth: 2, storageGbMonth: 0.1 },
    });
    const plain = computeCosts(inputs(), c);
    const spread = computeCosts(inputs(), c, { spreadShared: true });
    expect(plain.guests.find(x => x.name === 'proxy')!.shared).toBe(true); // matches the default name pattern
    expect(spread.total).toBeCloseTo(plain.total);
    expect(spread.guests.find(x => x.name === 'proxy')!.total).toBeCloseTo(0);
    expect(spread.guests.find(x => x.name === 'app')!.total).toBeGreaterThan(
      plain.guests.find(x => x.name === 'app')!.total,
    );
  });

  it('uses example rates, flagged, when nothing is configured', () => {
    const c = readCostConfig(new ConfigReader({}));
    expect(c.example).toBe(true);
    const r = computeCosts(inputs(), c);
    expect(r.rateSource.cpuCoreMonth).toBe('example');
    expect(r.total).toBeGreaterThan(0);
  });

  it('suggests right-sizing with a saving', () => {
    const r = computeCosts(
      inputs(),
      config({
        rates: { cpuCoreMonth: 10, memoryGbMonth: 2, storageGbMonth: 0.1 },
      }),
    );
    const hints = rightSizing(r);
    expect(hints.find(h => h.vmid === '103')?.kind).toBe(
      'stopped-holding-disk',
    );
    const mem = hints.find(
      h => h.vmid === '101' && h.kind === 'memory-oversized',
    );
    expect(mem?.monthlySaving).toBeGreaterThan(0);
  });
});
