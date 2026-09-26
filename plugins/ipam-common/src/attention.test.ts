import { findAttentionItems } from './attention';
import { IPAddress, IPStatus } from './types';

const now = new Date('2026-09-26T12:00:00Z');
const daysAgo = (d: number) =>
  new Date(now.getTime() - d * 24 * 3600 * 1000).toISOString();

const addr = (over: Partial<IPAddress>): IPAddress => ({
  id: over.ipAddress ?? '1',
  ipAddress: '10.20.30.1',
  subnetId: '7',
  status: IPStatus.ALLOCATED,
  source: 'proxmox',
  lastSeen: daysAgo(0),
  createdAt: '',
  updatedAt: '',
  ...over,
});

const categories = (addresses: IPAddress[], staleDays = 7) =>
  findAttentionItems(addresses, { now, staleDays }).map(
    i => `${i.category}:${i.address.ipAddress}`,
  );

describe('findAttentionItems', () => {
  it('flags devices only the ping sweep knows about', () => {
    expect(
      categories([
        addr({
          ipAddress: '10.20.30.164',
          source: 'scan',
          macAddress: 'bc:24:11:93:e4:96',
        }),
        addr({ ipAddress: '10.20.30.126', source: 'proxmox+arp' }),
      ]),
    ).toEqual(['unknown:10.20.30.164']);
  });

  it('treats addresses seen only by ARP (or scan+arp) as unknown, not proxmox+arp', () => {
    expect(
      categories([
        addr({ ipAddress: '10.20.30.2', source: 'arp' }),
        addr({ ipAddress: '10.20.30.3', source: 'scan+arp' }),
        addr({ ipAddress: '10.20.30.4', source: 'proxmox+arp' }),
        addr({ ipAddress: '10.20.30.5', source: 'dhcp+arp' }),
        addr({ ipAddress: '10.20.30.6', source: 'manual' }),
      ]),
    ).toEqual(['unknown:10.20.30.2', 'unknown:10.20.30.3']);
  });

  it('reads MAC conflicts recorded by the sync', () => {
    const items = findAttentionItems(
      [
        addr({
          ipAddress: '10.20.30.50',
          notes:
            'discovery: proxmox+arp; LXC 150; last seen 2026-09-26\nconflict: MAC differs between sources (arp 90:09:d0:65:6a:1c, proxmox bc:24:11:00:00:01)',
        }),
      ],
      { now, staleDays: 7 },
    );
    expect(items.map(i => i.category)).toEqual(['conflict']);
    expect(items[0].detail).toContain('MAC differs between sources');
  });

  it('flags stale and offline addresses, but not stopped guests or never-pinged ones', () => {
    expect(
      categories([
        addr({ ipAddress: '10.20.30.20', lastSeen: daysAgo(10) }),
        addr({ ipAddress: '10.20.30.21', lastSeen: daysAgo(3) }),
        addr({ ipAddress: '10.20.30.22', status: IPStatus.OFFLINE }),
        addr({
          ipAddress: '10.20.30.23',
          lastSeen: daysAgo(40),
          description: 'LXC 113 on pve10 (stopped)',
        }),
        addr({ ipAddress: '192.168.10.5', lastSeen: undefined }),
      ]),
    ).toEqual([
      'stale:10.20.30.20',
      'stale:10.20.30.22',
      'stoppedGuest:10.20.30.23',
    ]);
  });

  it('respects the chosen stale period', () => {
    expect(
      categories(
        [addr({ ipAddress: '10.20.30.20', lastSeen: daysAgo(10) })],
        30,
      ),
    ).toEqual([]);
  });

  it('flags a MAC shared by different hosts but not one host with several addresses', () => {
    expect(
      categories([
        addr({
          ipAddress: '10.20.30.10',
          hostname: 'pve10',
          macAddress: '98:F2:B3:30:10:58',
        }),
        addr({
          ipAddress: '10.20.30.11',
          hostname: 'pve10',
          macAddress: '98:f2:b3:30:10:58',
        }),
        addr({
          ipAddress: '10.20.30.70',
          hostname: 'app-a',
          macAddress: 'aa:aa:aa:aa:aa:aa',
        }),
        addr({
          ipAddress: '10.20.30.71',
          hostname: 'app-b',
          macAddress: 'AA:AA:AA:AA:AA:AA',
        }),
      ]),
    ).toEqual(['sharedMac:10.20.30.70', 'sharedMac:10.20.30.71']);
  });

  it('orders by urgency, then by IP numerically', () => {
    expect(
      categories([
        addr({ ipAddress: '10.20.30.100', lastSeen: daysAgo(30) }),
        addr({ ipAddress: '10.20.30.9', source: 'scan' }),
        addr({ ipAddress: '10.20.30.20', lastSeen: daysAgo(30) }),
      ]),
    ).toEqual([
      'unknown:10.20.30.9',
      'stale:10.20.30.20',
      'stale:10.20.30.100',
    ]);
  });

  it('flags non-DHCP addresses inside a DHCP pool', () => {
    const items = findAttentionItems(
      [
        addr({ ipAddress: '10.20.30.210', source: 'proxmox' }),
        addr({
          ipAddress: '10.20.30.211',
          source: 'dhcp',
          status: IPStatus.DHCP,
        }),
        addr({ ipAddress: '10.20.30.150', source: 'proxmox' }),
      ],
      {
        now,
        staleDays: 7,
        dhcpRanges: [{ from: '10.20.30.200', to: '10.20.30.254' }],
      },
    );
    expect(items.map(i => `${i.category}:${i.address.ipAddress}`)).toEqual([
      'dhcpPoolStatic:10.20.30.210',
    ]);
  });

  it('flags unowned or old reservations never seen on the network', () => {
    expect(
      categories([
        addr({
          ipAddress: '10.20.30.160',
          status: IPStatus.RESERVED,
          lastSeen: undefined,
        }),
        addr({
          ipAddress: '10.20.30.161',
          status: IPStatus.RESERVED,
          lastSeen: undefined,
          assignedTo: 'user:default/a',
          notes: `allocated: user:default/a for x on ${daysAgo(45)}`,
        }),
        addr({
          ipAddress: '10.20.30.162',
          status: IPStatus.RESERVED,
          lastSeen: undefined,
          assignedTo: 'user:default/a',
          notes: `allocated: user:default/a for x on ${daysAgo(3)}`,
        }),
        addr({
          ipAddress: '10.20.30.163',
          status: IPStatus.RESERVED,
          assignedTo: 'x',
        }),
      ]),
    ).toEqual([
      'staleReservation:10.20.30.160',
      'staleReservation:10.20.30.161',
    ]);
  });
});
