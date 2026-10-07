# @iswesolutions/plugin-proxmox-common

Code shared by [`@iswesolutions/plugin-proxmox`](../proxmox) and
[`@iswesolutions/plugin-proxmox-backend`](../proxmox-backend):

- **Types** for the cluster model: `ProxmoxResources`, `ProxmoxNode`,
  `ProxmoxGuest`, `ProxmoxStorage`, `ProxmoxDisk`, `ProxmoxCluster`, …
- **Permissions**: `proxmoxClusterManagePermission`
  (`proxmox.cluster.manage`), `proxmoxGuestPowerPermission`
  (`proxmox.guest.power`) and the `proxmoxPermissions` list.
- **Attention checks**: `findAttentionItems(resources, thresholds)`, which
  flags offline nodes, stopped guests, near-full or inactive storage and memory
  pressure.

You only need it directly to reference the permissions, for example in a
permission policy:

```ts
import { proxmoxClusterManagePermission } from '@iswesolutions/plugin-proxmox-common';
```
