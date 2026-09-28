import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions for the Proxmox plugin. Reading the cluster state is open to
 * every signed-in user (monitoring). The power permission gates guest
 * start/stop/reboot actions, which are disabled unless the backend is
 * explicitly configured to allow them (like Pulse, control is off by default).
 *
 * Granted through the RBAC policy (rbac/policy.csv) to the relevant
 * Keycloak-backed groups.
 */
export const proxmoxGuestPowerPermission = createPermission({
  name: 'proxmox.guest.power',
  attributes: { action: 'update' },
});

/** Add, edit or remove monitored Proxmox clusters (Settings tab). */
export const proxmoxClusterManagePermission = createPermission({
  name: 'proxmox.cluster.manage',
  attributes: { action: 'update' },
});

export const proxmoxPermissions = [
  proxmoxGuestPowerPermission,
  proxmoxClusterManagePermission,
];
