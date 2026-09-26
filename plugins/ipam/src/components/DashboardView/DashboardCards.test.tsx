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
  it('shows the last real run with its counts', () => {
    render(<SyncStatusCard now={now} runs={[run('2026-09-26T11:50:00Z')]} />);
    expect(screen.getByText(/10 min ago, 8s/)).toBeTruthy();
    expect(
      screen.getByText('Observed: proxmox 96 · dhcp 10 · arp 99'),
    ).toBeTruthy();
  });

  it('warns when the sync has gone quiet and shows errors', () => {
    render(
      <SyncStatusCard
        now={now}
        runs={[
          run('2026-09-26T10:00:00Z', { errors: ['dhcp: failed: timeout'] }),
        ]}
      />,
    );
    expect(screen.getByText(/finished 120 minutes ago/)).toBeTruthy();
    expect(screen.getByText('dhcp: failed: timeout')).toBeTruthy();
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
