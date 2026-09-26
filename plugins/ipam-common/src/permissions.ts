import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions for changing IPAM data through Backstage. Reading is open to
 * every signed-in user; these guard the write paths of the ipam backend and
 * decide whether the frontend shows the "Add" buttons.
 *
 * Granted through the RBAC policy (rbac/policy.csv) to the Keycloak-backed
 * groups phpIPAM Admins and phpIPAM Operators.
 */
export const ipamAddressCreatePermission = createPermission({
  name: 'ipam.address.create',
  attributes: { action: 'create' },
});

export const ipamSubnetCreatePermission = createPermission({
  name: 'ipam.subnet.create',
  attributes: { action: 'create' },
});

export const ipamPermissions = [
  ipamAddressCreatePermission,
  ipamSubnetCreatePermission,
];
