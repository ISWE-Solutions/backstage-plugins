import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { IPAMService } from './ipamService';
import { IPStatus } from '../types';

const subnets = [
  {
    id: '3',
    subnet: '10.20.30.0',
    mask: '24',
    isFolder: '0',
    vlanId: '0',
    description: 'DC1 LAN',
  },
  {
    id: '4',
    subnet: '0.0.0.0',
    mask: '',
    isFolder: '1',
    description: 'folder',
  },
];
const addresses = [
  {
    id: '10',
    subnetId: '3',
    ip: '10.20.30.126',
    hostname: 'keycloak',
    tag: '2',
    mac: 'bc:24:11:aa:bb:cc',
    description: 'LXC 115 on pve11',
    note: 'discovery: proxmox+arp; LXC 115 on pve11; last seen 2026-09-26 10:00',
    lastSeen: '2026-09-26 10:00:00',
    editDate: '2026-09-26 10:00:00',
  },
  {
    id: '11',
    subnetId: '3',
    ip: '10.20.30.200',
    hostname: 'printer',
    tag: '4',
    note: null,
  },
  {
    id: '12',
    subnetId: '3',
    ip: '10.20.30.50',
    hostname: '',
    tag: '1',
    note: 'SAN portal',
    lastSeen: '0000-00-00 00:00:00',
  },
];

const responses: Record<string, { status: number; body: unknown }> = {
  'subnets/': {
    status: 200,
    body: { code: 200, success: true, data: subnets },
  },
  'subnets/3/usage/': {
    status: 200,
    body: { code: 200, success: true, data: { maxhosts: 254, used: 3 } },
  },
  'addresses/': {
    status: 200,
    body: { code: 200, success: true, data: addresses },
  },
  'vlan/': {
    status: 404,
    body: { code: 404, success: false, message: 'No vlans configured' },
  },
};

const fetchApi: FetchApi = {
  fetch: jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = url.replace('http://backstage/api/proxy/phpipam/', '');
    const r = responses[key] ?? {
      status: 500,
      body: { success: false, message: `unexpected ${key}` },
    };
    return {
      ok: r.status < 400,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
    } as Response;
  }),
};
const discoveryApi: DiscoveryApi = {
  getBaseUrl: async () => 'http://backstage/api/proxy',
};

describe('IPAMService (phpIPAM)', () => {
  const service = new IPAMService(discoveryApi, fetchApi);

  it('maps phpIPAM addresses, tags and discovery sources', async () => {
    const { addresses: result } = await service.getIPAddresses();
    expect(result.map(a => [a.ipAddress, a.status, a.source])).toEqual([
      ['10.20.30.126', IPStatus.ALLOCATED, 'proxmox+arp'],
      ['10.20.30.200', IPStatus.DHCP, 'manual'],
      ['10.20.30.50', IPStatus.OFFLINE, 'manual'],
    ]);
    expect(result[0].macAddress).toBe('bc:24:11:aa:bb:cc');
    expect(result[0].lastSeen).toBe(
      new Date('2026-09-26T10:00:00').toISOString(),
    );
    expect(result[2].lastSeen).toBeUndefined();
  });

  it('filters by search text across hostname, MAC and source', async () => {
    const { addresses: bySource } = await service.getIPAddresses({
      search: 'proxmox',
    });
    expect(bySource.map(a => a.hostname)).toEqual(['keycloak']);
  });

  it('skips folders and computes utilisation from phpIPAM usage', async () => {
    const { subnets: result } = await service.getSubnets();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      network: '10.20.30.0',
      cidr: 24,
      totalIPs: 254,
      usedIPs: 3,
      availableIPs: 251,
    });
  });

  it('treats a 404 collection as empty', async () => {
    const { vlans } = await service.getVLANs();
    expect(vlans).toEqual([]);
  });
});
