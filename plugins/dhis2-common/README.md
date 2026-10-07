# @iswesolutions/plugin-dhis2-common

Permissions shared by [`@iswesolutions/plugin-dhis2`](../dhis2) and
[`@iswesolutions/plugin-dhis2-backend`](../dhis2-backend).

Viewing instances, job progress and logs only needs a Backstage session.
Changes need:

| Permission               | Allows                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `dhis2.instance.create`  | Provision instances (and the create dialog's database checks) |
| `dhis2.instance.clone`   | Clone an instance                                             |
| `dhis2.instance.update`  | Edit resources and settings, upgrade the DHIS2 version        |
| `dhis2.instance.operate` | Start, stop, restart, back up, refresh live state             |
| `dhis2.instance.restore` | Restore a database or move it to another server               |
| `dhis2.instance.delete`  | Decommission an instance                                      |
| `dhis2.proxy.manage`     | Read and write an instance's nginx files, tail proxy logs     |

```ts
import { dhis2Permissions } from '@iswesolutions/plugin-dhis2-common';
```
