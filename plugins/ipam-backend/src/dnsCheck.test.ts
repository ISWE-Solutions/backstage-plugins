import { checkDns } from './dnsCheck';
import { parseSyncRun } from './syncStatus';

const resolver = {
  resolve4: jest.fn(async (name: string) => {
    const table: Record<string, string[]> = {
      'app.example.org': ['10.20.30.20'],
      'moved.example.org': ['10.20.30.99'],
    };
    if (table[name]) return table[name];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  }),
  reverse: jest.fn(async (ip: string) => {
    if (ip === '10.20.30.30') return ['other-host.example.org'];
    if (ip === '10.20.30.31') return ['keycloak.example.org'];
    throw Object.assign(new Error('no PTR'), { code: 'ENOTFOUND' });
  }),
} as any;

describe('checkDns', () => {
  it('checks FQDNs forward, compares PTRs when present, ignores missing PTRs', async () => {
    const out = await checkDns(
      [
        { ip: '10.20.30.20', hostname: 'app.example.org' },
        { ip: '10.20.30.21', hostname: 'moved.example.org' },
        { ip: '10.20.30.22', hostname: 'gone.example.org' },
        { ip: '10.20.30.30', hostname: 'pve10' },
        { ip: '10.20.30.31', hostname: 'keycloak' },
        { ip: '10.20.30.32', hostname: 'bare-no-ptr' },
        { ip: '10.20.30.33', hostname: '' },
      ],
      resolver,
    );
    expect(out.map(m => [m.ip, m.problem])).toEqual([
      [
        '10.20.30.21',
        'moved.example.org resolves to 10.20.30.99, not 10.20.30.21',
      ],
      ['10.20.30.22', 'gone.example.org does not resolve (ENOTFOUND)'],
      ['10.20.30.30', 'reverse DNS for 10.20.30.30 is other-host.example.org'],
    ]);
  });
});

describe('parseSyncRun', () => {
  it('normalises a report and drops unexpected keys', () => {
    expect(
      parseSyncRun({
        finishedAt: '2026-09-26T10:00:00Z',
        durationSeconds: 12.7,
        sources: { proxmox: 96, dhcp: 10, 'bad key': 5, arp: -3 },
        created: 1,
        updated: '2',
        errors: ['dhcp: failed: x'],
        extra: 'ignored',
      }),
    ).toEqual({
      finishedAt: '2026-09-26T10:00:00.000Z',
      durationSeconds: 12,
      sources: { proxmox: 96, dhcp: 10, arp: 0 },
      created: 1,
      updated: 2,
      skipped: 0,
      errors: ['dhcp: failed: x'],
      dryRun: false,
    });
  });

  it('rejects a report without a valid timestamp', () => {
    expect(() => parseSyncRun({ finishedAt: 'yesterday' })).toThrow(
      /finishedAt/,
    );
  });
});
