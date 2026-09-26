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

export const ipamAddressUpdatePermission = createPermission({
  name: 'ipam.address.update',
  attributes: { action: 'update' },
});

export const ipamAddressDeletePermission = createPermission({
  name: 'ipam.address.delete',
  attributes: { action: 'delete' },
});

/** Splitting subnets and other subnet planning changes */
export const ipamSubnetUpdatePermission = createPermission({
  name: 'ipam.subnet.update',
  attributes: { action: 'update' },
});

export const ipamVlanCreatePermission = createPermission({
  name: 'ipam.vlan.create',
  attributes: { action: 'create' },
});

export const ipamPermissions = [
  ipamAddressCreatePermission,
  ipamAddressUpdatePermission,
  ipamAddressDeletePermission,
  ipamSubnetCreatePermission,
  ipamSubnetUpdatePermission,
  ipamVlanCreatePermission,
];
