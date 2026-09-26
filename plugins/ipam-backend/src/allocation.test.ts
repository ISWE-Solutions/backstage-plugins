import { AllocationService, ALLOCATION_MARKER } from './allocation';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;
const cfg = {
  subnet: '10.20.30.0',
  prefix: 24,
  from: '10.20.30.100',
  to: '10.20.30.104',
  gateway: '10.20.30.1',
};

/** In-memory phpIPAM: subnet 7 with a set of recorded addresses */
function fakePhpIpam(recorded: string[], refuse: string[] = []) {
  const records = new Map<string, any>();
  let nextId = 1000;
  recorded.forEach(ip =>
    records.set(String(nextId++), {
      id: String(nextId - 1),
      ip,
      tag: '2',
      note: '',
    }),
  );
  const request = jest.fn(async (method: string, path: string, body?: any) => {
    if (method === 'GET' && path === 'subnets/cidr/10.20.30.0/24/') {
      return { status: 200, body: { success: true, data: [{ id: '7' }] } };
    }
    if (method === 'GET' && path === 'subnets/7/addresses/') {
      return {
        status: 200,
        body: { success: true, data: [...records.values()] },
      };
    }
    if (method === 'POST' && path === 'addresses/') {
      const taken = [...records.values()].some(r => r.ip === body.ip);
      if (taken || refuse.includes(body.ip)) {
        return {
          status: 409,
          body: { success: false, message: 'IP address already exists' },
        };
      }
      const id = String(nextId++);
      records.set(id, {
        id,
        ip: body.ip,
        tag: String(body.tag),
        note: body.note,
      });
      return { status: 201, body: { success: true, id } };
    }
    const m = path.match(/^addresses\/(\d+)\/$/);
    if (m && method === 'GET') {
      const r = records.get(m[1]);
      return r
        ? { status: 200, body: { success: true, data: r } }
        : { status: 404, body: {} };
    }
    if (m && method === 'PATCH') {
      Object.assign(records.get(m[1]), { ...body, tag: String(body.tag) });
      return { status: 200, body: { success: true } };
    }
    if (m && method === 'DELETE') {
      records.delete(m[1]);
      return { status: 200, body: { success: true } };
    }
    return { status: 500, body: {} };
  });
  return { request, records };
}

const req = {
  hostname: 'hmis-test',
  purpose: 'DHIS2 instance hmis-test',
  requestedBy: 'user:default/tester',
};

describe('AllocationService', () => {
  it('skips recorded and live addresses and reserves the first free one', async () => {
    const php = fakePhpIpam(['10.20.30.100', '10.20.30.101']);
    const inUse = jest.fn(async (ip: string) => ip === '10.20.30.102');
    const svc = new AllocationService(php, cfg, logger, inUse);

    const a = await svc.allocate(req);
    expect(a).toMatchObject({
      ip: '10.20.30.103',
      prefix: 24,
      gateway: '10.20.30.1',
    });
    const rec = php.records.get(a.id);
    expect(rec.tag).toBe('3');
    expect(rec.note).toContain(`${ALLOCATION_MARKER} user:default/tester`);
    expect(inUse).not.toHaveBeenCalledWith('10.20.30.100');
  });

  it('moves on when phpIPAM refuses an address (created concurrently)', async () => {
    const php = fakePhpIpam([], ['10.20.30.100']);
    const svc = new AllocationService(php, cfg, logger, async () => false);
    expect((await svc.allocate(req)).ip).toBe('10.20.30.101');
  });

  it('never hands the same address to concurrent callers', async () => {
    const php = fakePhpIpam([]);
    const svc = new AllocationService(php, cfg, logger, async () => false);
    const [a, b, c] = await Promise.all([
      svc.allocate(req),
      svc.allocate(req),
      svc.allocate(req),
    ]);
    expect(new Set([a.ip, b.ip, c.ip]).size).toBe(3);
  });

  it('fails clearly when the pool is exhausted', async () => {
    const php = fakePhpIpam(['10.20.30.100', '10.20.30.101', '10.20.30.102']);
    const svc = new AllocationService(
      php,
      cfg,
      logger,
      async ip => ip >= '10.20.30.103',
    );
    await expect(svc.allocate(req)).rejects.toThrow(
      /No free address in 10\.20\.30\.100–10\.20\.30\.104 \(2 unrecorded/,
    );
  });

  it('confirms and releases only its own allocations', async () => {
    const php = fakePhpIpam(['10.20.30.100']);
    const svc = new AllocationService(php, cfg, logger, async () => false);
    const manualId = [...php.records.keys()][0];

    await expect(svc.release(manualId)).rejects.toThrow(
      /not created by allocation/,
    );
    await expect(svc.confirm(manualId, {})).rejects.toThrow(
      /not created by allocation/,
    );

    const a = await svc.allocate(req);
    await svc.confirm(a.id, {
      hostname: 'hmis-test',
      description: 'LXC 190 on pve12',
    });
    expect(php.records.get(a.id).tag).toBe('2');
    await expect(svc.release(a.id)).rejects.toThrow(/already in use/);

    const b = await svc.allocate(req);
    await svc.release(b.id);
    expect(php.records.has(b.id)).toBe(false);
  });
});
