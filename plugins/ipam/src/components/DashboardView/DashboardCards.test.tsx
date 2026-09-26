import { render, screen } from '@testing-library/react';
import { SyncStatusCard } from './SyncStatusCard';
import { UsageTrend } from './UsageTrend';

const run = (finishedAt: string, over: object = {}) => ({
  finishedAt,
  durationSeconds: 8,
  sources: { proxmox: 96, dhcp: 10, arp: 99 },
  created: 0,
  updated: 2,
  skipped: 0,
  errors: [],
  dryRun: false,
  ...over,
});
const now = new Date('2026-09-26T12:00:00Z');

describe('SyncStatusCard', () => {
  it('shows the last successful run with records added and changed', () => {
    render(
      <SyncStatusCard
        now={now}
        runs={[run('2026-09-26T11:50:00Z', { created: 3, updated: 5 })]}
      />,
    );
    expect(screen.getByText('Last successful run')).toBeTruthy();
    expect(screen.getByText(/10 min ago/)).toBeTruthy();
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Observed: proxmox 96 · dhcp 10 · arp 99'),
    ).toBeTruthy();
  });

  it('keeps the last good run visible when the latest failed, and totals 24h', () => {
    render(
      <SyncStatusCard
        now={now}
        runs={[
          run('2026-09-26T11:55:00Z', {
            errors: ['dhcp: failed: timeout'],
            created: 0,
            updated: 1,
          }),
          run('2026-09-26T11:40:00Z', { created: 2, updated: 4 }),
          run('2026-09-25T09:00:00Z', { created: 50, updated: 50 }),
        ]}
      />,
    );
    expect(screen.getByText('dhcp: failed: timeout')).toBeTruthy();
    expect(screen.getByText(/20 min ago/)).toBeTruthy(); // last success at 11:40
    // the 25 Sep run is older than 24 hours
    expect(screen.getByText(/2 runs · records added:/)).toBeTruthy();
  });

  it('warns when the sync has gone quiet', () => {
    render(<SyncStatusCard now={now} runs={[run('2026-09-26T10:00:00Z')]} />);
    expect(screen.getByText(/No run reported for 120 minutes/)).toBeTruthy();
  });

  it('explains how to enable reporting when nothing has been reported', () => {
    render(
      <SyncStatusCard
        now={now}
        runs={[run('2026-09-26T11:50:00Z', { dryRun: true })]}
      />,
    );
    expect(screen.getByText(/No sync run reported yet/)).toBeTruthy();
  });
});

describe('UsageTrend', () => {
  it('needs two days of data before drawing', () => {
    render(
      <UsageTrend
        points={[
          {
            date: '2026-09-26',
            subnetId: '7',
            cidr: '10.20.30.0/24',
            used: 116,
            max: 254,
          },
        ]}
      />,
    );
    expect(
      screen.getByText(/after the second day \(first snapshot: 2026-09-26\)/),
    ).toBeTruthy();
  });

  it('draws one line per subnet', () => {
    const { container } = render(
      <UsageTrend
        points={[
          {
            date: '2026-09-25',
            subnetId: '7',
            cidr: '10.20.30.0/24',
            used: 110,
            max: 254,
          },
          {
            date: '2026-09-26',
            subnetId: '7',
            cidr: '10.20.30.0/24',
            used: 116,
            max: 254,
          },
          {
            date: '2026-09-25',
            subnetId: '8',
            cidr: '192.168.10.0/24',
            used: 3,
            max: 254,
          },
          {
            date: '2026-09-26',
            subnetId: '8',
            cidr: '192.168.10.0/24',
            used: 3,
            max: 254,
          },
        ]}
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    // named in the line's tooltip and in the legend
    expect(screen.getAllByText('192.168.10.0/24').length).toBeGreaterThan(0);
  });
});
