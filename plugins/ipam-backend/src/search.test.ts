import { IpamCollatorFactory } from './search';

describe('IpamCollatorFactory', () => {
  it('produces one searchable document per address', async () => {
    const phpipam = {
      request: jest.fn(async (_m: string, path: string) =>
        path === 'subnets/'
          ? {
              status: 200,
              body: { data: [{ id: '7', subnet: '10.20.30.0', mask: '24' }] },
            }
          : {
              status: 200,
              body: {
                data: [
                  {
                    ip: '10.20.30.126',
                    hostname: 'keycloak',
                    subnetId: '7',
                    mac: 'bc:24:11:aa',
                    description: 'LXC 115 on pve11',
                    note: 'discovery: proxmox+arp; x',
                  },
                  {
                    ip: '10.20.30.2',
                    hostname: null,
                    subnetId: '7',
                    note: null,
                  },
                ],
              },
            },
      ),
    };
    const docs = [];
    for await (const d of new IpamCollatorFactory(phpipam).documents())
      docs.push(d);
    expect(docs).toEqual([
      {
        title: '10.20.30.126 — keycloak',
        text: 'keycloak · LXC 115 on pve11 · MAC bc:24:11:aa · subnet 10.20.30.0/24 · source proxmox+arp',
        location: '/ipam?tab=addresses&q=10.20.30.126',
      },
      {
        title: '10.20.30.2',
        text: 'subnet 10.20.30.0/24 · source manual',
        location: '/ipam?tab=addresses&q=10.20.30.2',
      },
    ]);
  });
});
