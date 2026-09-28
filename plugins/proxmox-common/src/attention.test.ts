import { findAttentionItems } from './attention';

const base = {
  nodes: [
    {
      node: 'pve10',
      status: 'online',
      cpu: 0.1,
      maxcpu: 8,
      mem: 15.5e9,
      maxmem: 16e9,
      uptime: 1,
    },
    {
      node: 'pve11',
      status: 'offline',
      cpu: 0,
      maxcpu: 8,
      mem: 0,
      maxmem: 16e9,
      uptime: 0,
    },
  ],
  guests: [
    {
      id: 'lxc/190',
      vmid: 190,
      type: 'lxc',
      name: 'ento',
      node: 'pve10',
      status: 'stopped',
      cpu: 0,
      maxcpu: 2,
      mem: 0,
      maxmem: 2e9,
      disk: 0,
      maxdisk: 0,
      uptime: 0,
      template: false,
      tags: [],
    },
    {
      id: 'qemu/9000',
      vmid: 9000,
      type: 'qemu',
      name: 'tmpl',
      node: 'pve10',
      status: 'stopped',
      cpu: 0,
      maxcpu: 2,
      mem: 0,
      maxmem: 2e9,
      disk: 0,
      maxdisk: 0,
      uptime: 0,
      template: true,
      tags: [],
    },
    {
      id: 'qemu/100',
      vmid: 100,
      type: 'qemu',
      name: 'db',
      node: 'pve10',
      status: 'running',
      cpu: 0.2,
      maxcpu: 4,
      mem: 3.9e9,
      maxmem: 4e9,
      disk: 0,
      maxdisk: 0,
      uptime: 9,
      template: false,
      tags: [],
    },
  ],
  storage: [
    {
      id: 's1',
      storage: 'uc3200',
      node: 'pve10',
      type: 'dir',
      content: '',
      used: 9.7e9,
      total: 1e10,
      avail: 0.3e9,
      usage: 0.97,
      shared: true,
      enabled: true,
      active: true,
    },
    {
      id: 's2',
      storage: 'down',
      node: 'pve10',
      type: 'dir',
      content: '',
      used: 0,
      total: 1e10,
      avail: 1e10,
      usage: 0,
      shared: false,
      enabled: true,
      active: false,
    },
  ],
} as any;

describe('findAttentionItems', () => {
  const items = findAttentionItems(base);
  const cats = items.map(i => i.category);

  it('flags an offline node', () => {
    expect(cats).toContain('nodeOffline');
  });
  it('flags a stopped non-template guest but not the template', () => {
    const stopped = items.filter(i => i.category === 'guestStopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].subject).toContain('190');
  });
  it('flags high node memory and high guest memory', () => {
    expect(cats).toContain('nodeMemoryHigh');
    expect(cats).toContain('guestMemoryHigh');
  });
  it('flags near-full and inactive storage', () => {
    expect(cats).toContain('storageFull');
    expect(cats).toContain('storageInactive');
  });
  it('does not report memory for the offline node', () => {
    const pve11 = items.filter(i => i.node === 'pve11');
    expect(pve11.every(i => i.category === 'nodeOffline')).toBe(true);
  });
  it('orders high severity first', () => {
    const firstWarning = items.findIndex(i => i.severity === 'warning');
    const lastHigh = items.map(i => i.severity).lastIndexOf('high');
    expect(lastHigh).toBeLessThan(
      firstWarning === -1 ? Infinity : firstWarning,
    );
  });
});
