# @internal/plugin-proxmox

Read-only **Proxmox VE monitoring** inside Backstage, inspired by
[Pulse](https://github.com/rcourtman/pulse). It surfaces the cluster's nodes,
guests (VMs and LXC), storage pools and a "needs attention" health view — the
same one-shared-model idea as Pulse, adapted to Backstage.

## Packages

| Package                            | Role            | What it does                                                          |
| ---------------------------------- | --------------- | --------------------------------------------------------------------- |
| `@internal/plugin-proxmox`         | frontend-plugin | The `/proxmox` page: Overview, Guests, Storage, Attention             |
| `@internal/plugin-proxmox-backend` | backend-plugin  | Gateway to the PVE API (`/cluster/resources`), caching, health checks |
| `@internal/plugin-proxmox-common`  | common-library  | Shared types, permissions, and the attention checks                   |

## How it works

```
/proxmox (signed-in users)  ──►  proxmox backend /api/proxmox/resources
                                 holds the PVE API token, caches ~15s
                                 └─►  Proxmox VE  GET /api2/json/cluster/resources
                                                   GET /api2/json/cluster/status
```

The frontend never talks to Proxmox directly; the backend holds the token and
aggregates `/cluster/resources` (one call covering nodes, guests and storage)
into a typed model. Results are cached briefly so the page's auto-refresh does
not hammer the PVE API.

The **Attention** tab runs health checks in the spirit of Pulse "Patrol":
offline nodes, stopped (non-template) guests, near-full or inactive storage, and
node/guest memory pressure.

## Multiple clusters

The plugin monitors **one or more clusters**, chosen with the cluster selector in
the page header. Clusters come from two places:

- **app-config** (read-only baseline) — the `proxmox.url/token` default cluster
  and any `proxmox.clusters[]`. Tokens stay in config, server-side.
- **the Settings tab** — clusters added at runtime, persisted in the backend
  database. Adding/editing/removing requires the `proxmox.cluster.manage`
  permission; **tokens are stored server-side and never returned to the browser**.

## Configuration

```yaml
proxmox:
  # default cluster
  url: https://10.20.30.10:8006 # any cluster member
  token: ${PROXMOX_TOKEN} # user@realm!tokenid=secret (read-only)
  name: DC1 # optional display name
  verifyTls: false # PVE ships a self-signed cert
  cacheSeconds: 15
  uiUrls: # optional deep links from the dashboard
    pve10: https://10.20.30.10:8006
  # additional clusters (optional)
  clusters:
    - name: DR
      url: https://10.60.0.10:8006
      token: ${PROXMOX_DR_TOKEN}
      verifyTls: false
  attention: # optional threshold overrides
    storageFull: 0.9
    nodeMemoryHigh: 0.9
    guestMemoryHigh: 0.95
```

### Creating the read-only token (PVEAuditor)

On a Proxmox node, create a role-limited API token so the plugin can only read:

```
pveum user token add monitoring@pve backstage --privsep 0
pveum acl modify / --roles PVEAuditor --tokens 'monitoring@pve!backstage'
```

Set the resulting `user@realm!tokenid=secret` as `PROXMOX_TOKEN` in the
Backstage backend's environment. Without it the page shows a "not configured"
error and the backend logs a warning.

## Permissions

Reading the cluster state is open to every signed-in user.
`proxmox.cluster.manage` gates adding/editing/removing clusters on the Settings
tab (granted to `group:default/admin` via the `proxmox-admin` role in
`rbac/policy.csv`). A `proxmox.guest.power` permission is defined for future
guest start/stop actions; no control actions are implemented yet (like Pulse,
control is off by default).
