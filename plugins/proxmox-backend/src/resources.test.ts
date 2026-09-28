import { fetchResources, mapCluster, mapResources } from './resources';

const raw = [
  {
    type: 'node',
    node: 'pve10',
    status: 'online',
    cpu: 0.1,
    maxcpu: 8,
    mem: 8e9,
    maxmem: 16e9,
    uptime: 1000,
  },
  { type: 'node', node: 'pve11', status: 'offline', maxcpu: 8, maxmem: 16e9 },
  {
    type: 'qemu',
    id: 'qemu/100',
    vmid: 100,
    name: 'db',
    node: 'pve10',
    status: 'running',
    cpu: 0.2,
    maxcpu: 4,
    mem: 2e9,
    maxmem: 4e9,
    maxdisk: 5e10,
    uptime: 900,
    template: '0',
    tags: 'db;prod',
  },
  {
    type: 'lxc',
    id: 'lxc/190',
    vmid: 190,
    name: 'ento',
    node: 'pve10',
    status: 'stopped',
    maxcpu: 2,
    maxmem: 2e9,
    template: '0',
  },
  {
    type: 'qemu',
    id: 'qemu/9000',
    vmid: 9000,
    name: 'tmpl',
    node: 'pve10',
    status: 'stopped',
    template: '1',
  },
  {
    type: 'storage',
    id: 'storage/pve10/local',
    storage: 'local',
    node: 'pve10',
    plugintype: 'dir',
    content: 'iso',
    used: 9.5e9,
    total: 1e10,
    shared: '0',
    status: 'available',
  },
  {
    type: 'storage',
    storage: 'uc3200',
    node: 'pve10',
    used: 5e9,
    total: 1e10,
    shared: '1',
    status: 'available',
  },
  { type: 'sdn', id: 'sdn/zone1' },
];

describe('mapResources', () => {
  it('maps nodes, guests and storage and ignores other types', () => {
    const { nodes, guests, storage } = mapResources(raw as any, {
      pve10: 'https://10.20.30.10:8006',
    });
    expect(nodes.map(n => n.node)).toEqual(['pve10', 'pve11']);
    expect(nodes[0].uiUrl).toBe('https://10.20.30.10:8006');
    expect(nodes[1].status).toBe('offline');

    expect(guests.map(g => g.vmid)).toEqual([100, 190, 9000]);
    const db = guests.find(g => g.vmid === 100)!;
    expect(db.type).toBe('qemu');
    expect(db.tags).toEqual(['db', 'prod']);
    expect(guests.find(g => g.vmid === 9000)!.template).toBe(true);

    expect(storage.map(s => s.storage)).toEqual(['local', 'uc3200']);
    const local = storage.find(s => s.storage === 'local')!;
    expect(local.usage).toBeCloseTo(0.95);
    expect(local.avail).toBeCloseTo(0.5e9);
    expect(storage.find(s => s.storage === 'uc3200')!.shared).toBe(true);
  });
});

describe('mapCluster', () => {
  it('reads cluster name and quorum from /cluster/status', () => {
    const { nodes } = mapResources(raw as any);
    const info = mapCluster(
      [{ type: 'cluster', name: 'DC1', quorate: 1, nodes: 4 }] as any,
      nodes,
    );
    expect(info).toMatchObject({
      name: 'DC1',
      quorate: true,
      nodesTotal: 4,
      nodesOnline: 1,
    });
  });

  it('falls back to node counts for a standalone node', () => {
    const { nodes } = mapResources(raw as any);
    expect(mapCluster(undefined, nodes)).toMatchObject({
      nodesOnline: 1,
      nodesTotal: 2,
    });
  });
});

describe('fetchResources', () => {
  it('aggregates /cluster/resources and /cluster/status', async () => {
    const client = {
      get: jest.fn(async (path: string) => {
        if (path === 'cluster/resources')
          return { status: 200, body: { data: raw } };
        if (path === 'cluster/status')
          return {
            status: 200,
            body: { data: [{ type: 'cluster', name: 'DC1', quorate: 1 }] },
          };
        return { status: 404, body: {} };
      }),
    };
    const r = await fetchResources(client, { pve10: 'https://ui' });
    expect(r.cluster.name).toBe('DC1');
    expect(r.nodes).toHaveLength(2);
    expect(r.guests).toHaveLength(3);
    expect(r.storage).toHaveLength(2);
    expect(typeof r.generatedAt).toBe('string');
  });

  it('throws on an upstream error', async () => {
    const client = { get: jest.fn(async () => ({ status: 401, body: {} })) };
    await expect(fetchResources(client)).rejects.toThrow(/401/);
  });
});
