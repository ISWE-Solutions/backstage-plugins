# @iswesolutions/plugin-ipam-common

Code shared by [`@iswesolutions/plugin-ipam`](../ipam) and
[`@iswesolutions/plugin-ipam-backend`](../ipam-backend):

- **Types**: `IPAddress`, `Subnet`, `VLAN`, `IPStatus`, `IPAMStatistics`, …
- **phpIPAM mapping**: `toAddress()` and the phpIPAM tag and status constants,
  which convert raw phpIPAM API records into the types above.
- **Permissions**: `ipam.address.create`, `ipam.address.update`,
  `ipam.address.delete`, `ipam.subnet.create`, `ipam.subnet.update`,
  `ipam.vlan.create`, and the `ipamPermissions` list.
- **Attention checks**: `findAttentionItems(addresses, options)`, which flags
  MAC conflicts, unknown devices, shared MACs, configuration drift, static
  addresses inside DHCP pools, stale reservations, stale addresses and
  addresses held by stopped guests.

You only need it directly to reference the permissions, for example in a
permission policy:

```ts
import { ipamAddressCreatePermission } from '@iswesolutions/plugin-ipam-common';
```
