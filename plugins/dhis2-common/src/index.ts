import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions for changing DHIS2 instances through Backstage. Viewing the
 * instance list, job progress and instance logs needs only a Backstage
 * session. Granted through rbac/policy.csv (roles dhis2-operator and
 * dhis2-admin).
 */

/** Provision new instances (and the database checks / dump upload the create dialog uses) */
export const dhis2InstanceCreatePermission = createPermission({
  name: 'dhis2.instance.create',
  attributes: { action: 'create' },
});

export const dhis2InstanceClonePermission = createPermission({
  name: 'dhis2.instance.clone',
  attributes: { action: 'create' },
});

/** Edit resources/settings and upgrade the DHIS2 version */
export const dhis2InstanceUpdatePermission = createPermission({
  name: 'dhis2.instance.update',
  attributes: { action: 'update' },
});

/** Start, stop, restart, back up, refresh live state */
export const dhis2InstanceOperatePermission = createPermission({
  name: 'dhis2.instance.operate',
  attributes: { action: 'update' },
});

/** Restore a database into an instance or move its database to another server */
export const dhis2InstanceRestorePermission = createPermission({
  name: 'dhis2.instance.restore',
  attributes: { action: 'update' },
});

/** Decommission (delete) an instance */
export const dhis2InstanceDeletePermission = createPermission({
  name: 'dhis2.instance.delete',
  attributes: { action: 'delete' },
});

/** Read/write an instance's nginx proxy files and tail proxy logs */
export const dhis2ProxyManagePermission = createPermission({
  name: 'dhis2.proxy.manage',
  attributes: { action: 'update' },
});

export const dhis2Permissions = [
  dhis2InstanceCreatePermission,
  dhis2InstanceClonePermission,
  dhis2InstanceUpdatePermission,
  dhis2InstanceOperatePermission,
  dhis2InstanceRestorePermission,
  dhis2InstanceDeletePermission,
  dhis2ProxyManagePermission,
];
