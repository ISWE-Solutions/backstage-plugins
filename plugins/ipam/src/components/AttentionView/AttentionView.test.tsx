import { fireEvent, screen, within } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { AttentionView } from './AttentionView';
import { ipamApiRef } from '../../services/ipamService';
import { IPStatus } from '../../types';
import { downloadText } from '../IPListView/csv';

jest.mock('../IPListView/csv', () => ({
  ...jest.requireActual('../IPListView/csv'),
  downloadText: jest.fn(),
}));

const api = {
  getIPAddresses: jest.fn(async () => ({
    addresses: [
      {
        id: '1',
        ipAddress: '10.20.30.201',
        subnetId: '7',
        status: IPStatus.ALLOCATED,
        source: 'arp',
        macAddress: 'bc:24:11:00:00:01',
        createdAt: '',
        updatedAt: '',
      },
    ],
    total_entries: 1,
  })),
  getSubnets: jest.fn(async () => ({
    subnets: [
      {
        id: '7',
        network: '10.20.30.0',
        cidr: 24,
        totalIPs: 254,
        usedIPs: 1,
        availableIPs: 253,
        utilizationPercent: 0.4,
        createdAt: '',
        updatedAt: '',
      },
    ],
    total_entries: 1,
  })),
  getConfig: jest.fn(async () => ({
    dhcpRanges: [],
    proxmoxUiUrls: {},
    allocationPool: null,
  })),
  getDnsCheck: jest.fn(),
};

const renderView = () =>
  renderInTestApp(
    <TestApiProvider apis={[[ipamApiRef, api]]}>
      <AttentionView />
    </TestApiProvider>,
  );

const headers = () =>
  screen.getAllByRole('columnheader', { hidden: true }).map(h => h.textContent);

describe('AttentionView columns', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows the default columns, with MAC Address hidden', async () => {
    await renderView();
    expect(await screen.findByText('10.20.30.201')).toBeTruthy();
    expect(headers()).toEqual([
      'Issue',
      'IP Address',
      'Hostname',
      'Subnet',
      'Source',
      'Detail',
      'Last Seen',
    ]);
  });

  it('exports only the visible columns', async () => {
    await renderView();
    await screen.findByText('10.20.30.201');

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('Detail'));
    fireEvent.click(within(menu).getByText('MAC Address'));
    expect(headers()).toContain('MAC Address');
    expect(headers()).not.toContain('Detail');
    expect(
      JSON.parse(window.localStorage.getItem('ipam.attentionView.columns.v1')!),
    ).toMatchObject({ hidden: ['detail'] });
    fireEvent.keyDown(menu, { key: 'Escape' });

    fireEvent.click(
      screen.getByRole('button', { name: 'Export CSV', hidden: true }),
    );
    const csv = (downloadText as jest.Mock).mock.calls[0][1] as string;
    const [head, row] = csv.trim().split(/\r?\n/);
    expect(head).toBe(
      'Issue,IP Address,Hostname,Subnet,Source,MAC Address,Last Seen',
    );
    expect(row).toContain('10.20.30.201');
    expect(row).toContain('10.20.30.0/24');
    expect(row).toContain('bc:24:11:00:00:01');
  });
});
