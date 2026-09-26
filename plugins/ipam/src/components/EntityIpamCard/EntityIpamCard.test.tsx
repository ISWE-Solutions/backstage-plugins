import { screen } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { EntityIpamCard, entityHostnames } from './EntityIpamCard';
import { ipamApiRef } from '../../services/ipamService';
import { IPStatus } from '../../types';

const address = (ip: string, hostname: string) =>
  ({
    id: ip,
    ipAddress: ip,
    hostname,
    subnetId: '7',
    status: IPStatus.ALLOCATED,
    source: 'proxmox',
    createdAt: '',
    updatedAt: '',
  } as any);
const api = {
  getIPAddresses: jest.fn(async () => ({
    addresses: [
      address('10.20.30.126', 'keycloak'),
      address('10.20.30.127', 'phpIPAM'),
    ],
    total_entries: 2,
  })),
};
const entity = (name: string, annotations?: Record<string, string>) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations },
  spec: {},
});

const renderCard = (e: any) =>
  renderInTestApp(
    <TestApiProvider apis={[[ipamApiRef, api]]}>
      <EntityProvider entity={e}>
        <EntityIpamCard />
      </EntityProvider>
    </TestApiProvider>,
  );

describe('EntityIpamCard', () => {
  it('lists addresses whose hostname matches the entity name', async () => {
    await renderCard(entity('keycloak'));
    expect(await screen.findByText('10.20.30.126')).toBeTruthy();
    expect(screen.queryByText('10.20.30.127')).toBeNull();
  });

  it('uses the hostnames annotation when present', async () => {
    await renderCard(
      entity('ipam', { 'ipam.example.org/hostnames': 'phpipam, keycloak' }),
    );
    expect(await screen.findByText('10.20.30.127')).toBeTruthy();
    expect(screen.getByText('10.20.30.126')).toBeTruthy();
  });

  it('renders nothing when no address matches', async () => {
    await renderCard(entity('unrelated'));
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('IP addresses')).toBeNull();
  });

  it('reads hostnames case-insensitively', () => {
    expect(
      entityHostnames(entity('X', { 'ipam.example.org/hostnames': 'A, b ,' })),
    ).toEqual(['a', 'b']);
  });
});
