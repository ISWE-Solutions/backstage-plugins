import { fireEvent, screen, within } from '@testing-library/react';
import {
  MockPermissionApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { SubnetListView } from './SubnetListView';
import { ipamApiRef } from '../../services/ipamService';
import { downloadText } from '../IPListView/csv';

jest.mock('../IPListView/csv', () => ({
  ...jest.requireActual('../IPListView/csv'),
  downloadText: jest.fn(),
}));

const api = {
  getSubnets: jest.fn(async () => ({
    subnets: [
      {
        id: '7',
        network: '10.20.30.0',
        cidr: 24,
        gateway: '10.20.30.1',
        description: 'Server LAN',
        vlanId: '3',
        totalIPs: 254,
        usedIPs: 127,
        availableIPs: 127,
        utilizationPercent: 50,
        createdAt: '',
        updatedAt: '',
      },
    ],
    total_entries: 1,
  })),
  getVLANs: jest.fn(async () => ({
    vlans: [
      {
        id: '3',
        vlanId: 44,
        name: 'servers',
        subnets: ['7'],
        createdAt: '',
        updatedAt: '',
      },
    ],
    total_entries: 1,
  })),
};

const renderList = () =>
  renderInTestApp(
    <TestApiProvider
      apis={[
        [ipamApiRef, api],
        [permissionApiRef, new MockPermissionApi()],
      ]}
    >
      <SubnetListView />
    </TestApiProvider>,
  );

const headers = () =>
  screen.getAllByRole('columnheader', { hidden: true }).map(h => h.textContent);

describe('SubnetListView columns', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows the default columns, with VLAN and Location hidden', async () => {
    await renderList();
    expect(await screen.findByText('Server LAN')).toBeTruthy();
    expect(headers()).toEqual([
      'Network',
      'Description',
      'Gateway',
      'IP Utilization',
      'Total IPs',
      'Used',
      'Available',
      'Actions',
    ]);
  });

  it('hides and shows columns from the Columns menu', async () => {
    await renderList();
    await screen.findByText('Server LAN');

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('Gateway'));
    expect(headers()).not.toContain('Gateway');

    fireEvent.click(within(menu).getByText('VLAN'));
    expect(headers()).toContain('VLAN');
    expect(screen.getByText('44 servers')).toBeTruthy();
    expect(
      JSON.parse(
        window.localStorage.getItem('ipam.subnetListView.columns.v1')!,
      ),
    ).toMatchObject({ hidden: ['location', 'gateway'] });
  });

  it('resizes a column with the keyboard', async () => {
    await renderList();
    await screen.findByText('Server LAN');
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Resize Description column' }),
      { key: 'ArrowRight' },
    );
    expect(
      JSON.parse(window.localStorage.getItem('ipam.subnetListView.columns.v1')!)
        .widths,
    ).toEqual({ description: 230 });
  });

  it('exports the visible columns to CSV', async () => {
    await renderList();
    await screen.findByText('Server LAN');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const csv = (downloadText as jest.Mock).mock.calls[0][1] as string;
    const [head, row] = csv.trim().split(/\r?\n/);
    expect(head).toBe(
      'Network,Description,Gateway,IP Utilization,Total IPs,Used,Available',
    );
    expect(row).toContain('10.20.30.0/24');
    expect(row).toContain('Server LAN');
    expect(row).toContain('254');
  });
});
