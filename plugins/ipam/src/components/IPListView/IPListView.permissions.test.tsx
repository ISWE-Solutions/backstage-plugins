import { screen, waitFor } from '@testing-library/react';
import {
  MockPermissionApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { IPListView } from './IPListView';
import { ipamApiRef } from '../../services/ipamService';

// Separate file on purpose: usePermission caches decisions (SWR, with a
// 2-second dedupe window), so a DENY test sharing a module registry with
// ALLOW tests would see their cached result.
const api = {
  getIPAddresses: jest.fn(async () => ({ addresses: [], total_entries: 0 })),
  getSubnets: jest.fn(async () => ({ subnets: [], total_entries: 0 })),
  getVLANs: jest.fn(async () => ({ vlans: [], total_entries: 0 })),
};

describe('IPListView permissions', () => {
  it('disables Add IP Address without ipam.address.create', async () => {
    await renderInTestApp(
      <TestApiProvider
        apis={[
          [ipamApiRef, api],
          [permissionApiRef, new MockPermissionApi(() => AuthorizeResult.DENY)],
        ]}
      >
        <IPListView />
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: /add ip address/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
  });
});
