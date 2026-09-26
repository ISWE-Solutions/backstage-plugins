import { fireEvent, render, screen } from '@testing-library/react';
import { SubnetMap } from './SubnetMap';
import { IPStatus } from '../../types';

const subnet = {
  id: '7',
  network: '10.20.30.0',
  cidr: 24,
  totalIPs: 254,
  usedIPs: 2,
  availableIPs: 252,
  utilizationPercent: 1,
  createdAt: '',
  updatedAt: '',
};
const addr = (ip: string, status: IPStatus, hostname: string) =>
  ({
    id: ip,
    ipAddress: ip,
    subnetId: '7',
    status,
    hostname,
    source: 'proxmox',
    createdAt: '',
    updatedAt: '',
  } as any);

describe('SubnetMap', () => {
  it('draws one cell per host, marks the DHCP pool and selects used cells', () => {
    const onSelect = jest.fn();
    render(
      <SubnetMap
        subnet={subnet}
        addresses={[
          addr('10.20.30.10', IPStatus.ALLOCATED, 'pve10'),
          addr('10.20.30.210', IPStatus.DHCP, 'laptop'),
        ]}
        dhcpRanges={[{ from: '10.20.30.200', to: '10.20.30.254' }]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getAllByLabelText(/^10\.20\.30\.\d+ — /)).toHaveLength(254);
    expect(
      screen.getByLabelText('10.20.30.201 — free (DHCP pool)'),
    ).toBeTruthy();
    expect(screen.getByLabelText('10.20.30.50 — free')).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText('10.20.30.10 — pve10 (allocated, proxmox)'),
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.20.30.10' }),
    );
  });

  it('declines subnets too large to draw', () => {
    render(
      <SubnetMap
        subnet={{ ...subnet, cidr: 16 }}
        addresses={[]}
        dhcpRanges={[]}
      />,
    );
    expect(
      screen.getByText(/available for subnets from \/22 to \/30/),
    ).toBeTruthy();
  });
});
