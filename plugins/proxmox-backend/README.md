# @iswesolutions/plugin-proxmox-backend

Backend for [`@iswesolutions/plugin-proxmox`](../proxmox). It holds the
Proxmox VE API tokens, reads `/cluster/resources` and `/cluster/status`,
caches the result briefly, and serves the typed model and attention checks to
the frontend. The browser never talks to Proxmox directly.

## Installation

```sh
yarn --cwd packages/backend add @iswesolutions/plugin-proxmox-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@iswesolutions/plugin-proxmox-backend'));
```

## Configuration

```yaml
proxmox:
  url: https://pve.example.com:8006 # any cluster member
  token: ${PROXMOX_TOKEN} # user@realm!tokenid=secret
  name: Primary # optional display name
  verifyTls: false # PVE ships a self-signed certificate
  cacheSeconds: 15
  uiUrls: # optional: node -> web UI, for deep links
    pve1: https://pve1.example.com:8006
  clusters: # optional additional clusters
    - name: DR
      url: https://pve-dr.example.com:8006
      token: ${PROXMOX_DR_TOKEN}
  attention: # optional threshold overrides
    storageFull: 0.9
    nodeMemoryHigh: 0.9
    guestMemoryHigh: 0.95
```

Use a read-only token:

```sh
pveum user token add monitoring@pve backstage --privsep 0
pveum acl modify / --roles PVEAuditor --tokens 'monitoring@pve!backstage'
```

Clusters can also be added on the page's Settings tab. Those are stored in the
plugin's database, and their tokens are never returned to the browser. See
[`config.d.ts`](config.d.ts) for every option.

## API

All routes, under `/api/proxmox`, need a signed-in user or a backend service token:

| Route                                        | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `GET /resources`                             | Nodes, guests and storage for a cluster (`?cluster=`)   |
| `GET /attention`                             | Health findings (offline nodes, full storage, …)        |
| `GET /disks`, `GET /disks/smart`             | Physical disks and SMART data                           |
| `GET /clusters`                              | Configured clusters (no tokens)                         |
| `POST /clusters/test`                        | Test a cluster connection                               |
| `POST /clusters`, `PUT/DELETE /clusters/:id` | Manage Settings-tab clusters (`proxmox.cluster.manage`) |

## Permissions

Defined in [`@iswesolutions/plugin-proxmox-common`](../proxmox-common):
`proxmox.cluster.manage` gates adding, editing and removing clusters.
`proxmox.guest.power` is reserved for future start/stop actions.
