import { usePermission } from '@backstage/plugin-permission-react';
import {
  dhis2InstanceClonePermission,
  dhis2InstanceCreatePermission,
  dhis2InstanceDeletePermission,
  dhis2InstanceOperatePermission,
  dhis2InstanceRestorePermission,
  dhis2InstanceUpdatePermission,
  dhis2ProxyManagePermission,
} from '@internal/plugin-dhis2-common';

/**
 * Which DHIS2 actions the signed-in user may take (rbac/policy.csv). The
 * backend enforces the same permissions; this only decides what is enabled.
 */
export function useDhis2Permissions() {
  return {
    create: usePermission({ permission: dhis2InstanceCreatePermission })
      .allowed,
    clone: usePermission({ permission: dhis2InstanceClonePermission }).allowed,
    update: usePermission({ permission: dhis2InstanceUpdatePermission })
      .allowed,
    operate: usePermission({ permission: dhis2InstanceOperatePermission })
      .allowed,
    restore: usePermission({ permission: dhis2InstanceRestorePermission })
      .allowed,
    remove: usePermission({ permission: dhis2InstanceDeletePermission })
      .allowed,
    proxy: usePermission({ permission: dhis2ProxyManagePermission }).allowed,
  };
}

/** Tooltip text for a control the user lacks permission for */
export const needsPermission = (title: string, allowed: boolean) =>
  allowed
    ? title
    : `${title} — you don't have permission (DHIS2 role in SSO)`;
