import { fireEvent, screen, within } from '@testing-library/react';
import {
  MockPermissionApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { IPListView } from './IPListView';
import { ipamApiRef } from '../../services/ipamService';
import { IPStatus } from '../../types';

const api = {
  getIPAddresses: jest.fn(async () => ({
    addresses: [
      {
        id: '1',
        ipAddress: '10.20.30.126',
        subnetId: '7',
        hostname: 'keycloak',
        status: IPStatus.ALLOCATED,
        source: 'proxmox+arp',
        macAddress: 'bc:24:11:aa:bb:cc',
        description: 'LXC 115 on pve11',
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
  getVLANs: jest.fn(async () => ({ vlans: [], total_entries: 0 })),
};

const renderList = () =>
  renderInTestApp(
    <TestApiProvider
      apis={[
        [ipamApiRef, api],
        [permissionApiRef, new MockPermissionApi()],
      ]}
    >
      <IPListView />
    </TestApiProvider>,
  );

const headers = () =>
  // hidden: true because an open MUI menu marks the rest of the page aria-hidden
  screen.getAllByRole('columnheader', { hidden: true }).map(h => h.textContent);

describe('IPListView columns', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows the default columns, with VLAN and Assigned To hidden', async () => {
    await renderList();
    expect(await screen.findByText('keycloak')).toBeTruthy();
    expect(headers()).toEqual([
      'IP Address',
      'Hostname',
      'Status',
      'Subnet',
      'Source',
      'MAC Address',
      'Description',
      'Last Seen',
    ]);
  });

  it('hides and shows a column from the Columns menu', async () => {
    await renderList();
    await screen.findByText('keycloak');

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('MAC Address'));
    expect(headers()).not.toContain('MAC Address');
    expect(screen.queryByText('bc:24:11:aa:bb:cc')).toBeNull();

    fireEvent.click(within(menu).getByText('VLAN'));
    expect(headers()).toContain('VLAN');
    expect(
      JSON.parse(window.localStorage.getItem('ipam.ipListView.columns.v1')!),
    ).toMatchObject({ hidden: ['assignedTo', 'macAddress'] });
  });

  it('resizes a column with the keyboard', async () => {
    await renderList();
    await screen.findByText('keycloak');
    const handle = screen.getByRole('button', {
      name: 'Resize Hostname column',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(
      JSON.parse(window.localStorage.getItem('ipam.ipListView.columns.v1')!)
        .widths,
    ).toEqual({ hostname: 200 });
  });
});
