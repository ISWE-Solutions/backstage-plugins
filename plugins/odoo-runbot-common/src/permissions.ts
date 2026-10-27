import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Reading builds is open to every signed-in user. These guard changes.
 * Grant them through RBAC (the Administration page).
 */

/** Projects, repositories and triggers */
export const runbotConfigurePermission = createPermission({
  name: 'odoo-runbot.configure',
  attributes: { action: 'update' },
});

/** Rebuild, kill and force a batch */
export const runbotBuildManagePermission = createPermission({
  name: 'odoo-runbot.build.manage',
  attributes: { action: 'update' },
});

export const runbotPermissions = [
  runbotConfigurePermission,
  runbotBuildManagePermission,
];
