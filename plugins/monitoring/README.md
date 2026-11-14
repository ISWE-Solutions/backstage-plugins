# Monitoring plugin

A Backstage frontend plugin with one **Monitoring** page and four tabs:

| Tab                     | Shows                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prometheus / Health** | **Live:** catalog Components with their site check, 24-hour uptime, response time, certificate expiry, and CPU and memory, from Prometheus                                      |
| **Grafana Dashboards**  | **Live:** every dashboard in Grafana, by folder, with search; each opens in Grafana                                                                                             |
| **Security Insights**   | **Live:** the GitHub organization's open Dependabot and code-scanning alerts, by severity, repository and ecosystem; forks left out by default                                  |
| **Cost Insights**       | **Live:** what each Proxmox container and VM costs (CPU, memory, storage, network, backups), by guest, node, environment, catalog Component and System, with right-sizing hints |

All four tabs are live.

## Live System Health

The tab lists every catalog **Component** with an
`iswesolutions.com/health-url` annotation:

```yaml
metadata:
  annotations:
    # the URL the site checks probe (exactly as in the http_url label)
    iswesolutions.com/health-url: https://sso.example.org/
    # optional: Proxmox guests the service runs in, for CPU and memory
    iswesolutions.com/proxmox-guests: keycloak, keycloak-db
```

It queries Prometheus through the Backstage proxy, every minute:

| Shown                 | Metric                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| Status, uptime (24 h) | `httpcheck_status` (OpenTelemetry `httpcheckreceiver`), 2xx/3xx counts as up        |
| Response time         | `httpcheck_duration_milliseconds`                                                   |
| Certificate           | `tlscheck_time_left_seconds` (`tlscheckreceiver`), matched on the URL's host name   |
| CPU and memory        | `pve_guest_cpu_ratio`, `pve_guest_memory_used_bytes` / `_max_bytes` by guest `name` |

- **Down:** no probe got a 2xx/3xx in the last 5 minutes.
- **Degraded:** slower than 3 s, a certificate under 14 days, CPU or memory
  over 90% (the busiest guest), or under 99% uptime over 24 hours. The card
  says which.
- **No data:** no site check series for that URL.

By default the requests go through Grafana's datasource proxy, so the proxy
route that the Grafana plugin uses is enough (a Viewer service-account token,
GET only):

```yaml
proxy:
  endpoints:
    /grafana/api:
      target: https://grafana.example.org/
      allowedMethods: [GET]
      headers:
        Authorization: Bearer ${GRAFANA_TOKEN}
```

with a Prometheus datasource whose uid is `prometheus`. To use another route,
set the path under the proxy (without `/api/v1/query`):

```yaml
monitoring:
  prometheusProxyPath: /prometheus
```

## Live Grafana Dashboards

The tab lists every dashboard Grafana's search API returns for the proxy's token
(`GET /api/search?type=dash-db`, through the same `/grafana/api` proxy route as
System Health), grouped by folder, with a search box. Links go to Grafana at
`monitoring.grafanaUrl`, or the community Grafana plugin's default host
(`grafana.hosts` / `grafana.defaultHost`, or `grafana.domain`):

```yaml
monitoring:
  grafanaUrl: https://grafana.example.org # optional
  grafanaFolderOrder: [VSDC, Network traffic, Platform] # folders shown first
  grafanaProxyPath: /grafana/api # optional
```

## Live Security Insights

The tab lists the organization's **open Dependabot and code-scanning alerts**
from GitHub's org-wide APIs, page by page (cached for 15 minutes in the browser
session; a Refresh button reloads): severity counts (click to filter), alerts
by repository and by ecosystem or tool, and a table linking each alert to
GitHub. Repositories that are forks of upstream projects are left out by
default, with a switch to include them.

It needs two proxy routes, each pointing at exactly one alert list, so the
browser can't use the token for anything else:

```yaml
proxy:
  endpoints:
    /github-security/dependabot:
      target: https://api.github.com/orgs/<org>/dependabot/alerts
      changeOrigin: true
      allowedMethods: [GET]
      headers:
        Authorization: Bearer ${GITHUB_TOKEN}
        Accept: application/vnd.github+json
    /github-security/code-scanning:
      target: https://api.github.com/orgs/<org>/code-scanning/alerts
      changeOrigin: true
      allowedMethods: [GET]
      headers:
        Authorization: Bearer ${GITHUB_TOKEN}
        Accept: application/vnd.github+json
```

The token must be able to read security alerts: a classic token of an
organization owner (or security manager) with the `security_events` scope, or a
fine-grained token with "Dependabot alerts" and "Code scanning alerts" (read).
When GitHub refuses, the tab says why. Secret-scanning alerts are left out on
purpose: GitHub's API returns the secret itself.
`monitoring.githubSecurityProxyPath` changes the `/github-security` prefix.

## Live Cost Insights

Every Proxmox guest (running, stopped, or deleted during the period) is
charged for what it took from five pools, over 24 hours, 7 days, 30 days or the
month to date:

| Pool    | Charged on                                                                                                     | Metric                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| CPU     | core-hours used (allotted cores are overcommitted, so they're no fair measure; `cpuBasis` changes it)          | `pve_guest_cpu_used_cores`, `pve_guest_cpu_cores`               |
| Memory  | GiB-hours while running: containers half on use, half on the limit; VMs their full RAM (committed on the host) | `pve_guest_memory_used_bytes`, `pve_guest_memory_max_bytes`     |
| Storage | GiB allotted, all period, running or stopped                                                                   | `pve_guest_disk_max_bytes`                                      |
| Network | GiB received and sent                                                                                          | `pve_guest_net_in_bytes_total`, `pve_guest_net_out_bytes_total` |
| Backups | the backup server's real use, shared out by the size of each guest's newest backup                             | `pve_guest_backup_bytes`, `pve_pbs_used_bytes`                  |

Capacity comes from `pve_node_cpu_cores`, `pve_node_memory_total_bytes`,
`pve_storage_size_bytes{storage="local-lvm"}` and `pve_pbs_total_bytes`. The
metrics are made by ISWE's `pve-guest-usage.py` and `pve-metrics.py` (every
minute and every 5 minutes, through OpenTelemetry to Prometheus).

Prices come from either of two settings; without both, the tab shows **example
rates** and says so:

```yaml
monitoring:
  costs:
    currency: ZMW
    # Cost recovery: what the infrastructure costs per month, split across the pools.
    # Rates = pool's share / max(capacity, demand), so an overcommitted pool recovers exactly
    # its share; what guests don't take up is shown as unused capacity. Network is shared out
    # by traffic.
    monthlyInfrastructureCost: 50000
    split:
      { cpu: 0.35, memory: 0.35, storage: 0.15, network: 0.1, backup: 0.05 }
    # A price list instead (each rate overrides the derived one):
    # rates: { cpuCoreMonth: 300, memoryGbMonth: 80, storageGbMonth: 2, networkGb: 1, backupGbMonth: 0.5, guestMonth: 0 }
    # cpuBasis: used | allocated | blend   (cpuAllocatedWeight: 0.25)
    # memoryBasis: blend                   (memoryAllocatedWeight: 0.5)
    # vmMemoryBasis: allocated
    # networkDirection: both | out
    # Shared services, which a switch spreads over the other guests:
    # sharedEnvironments: [shared]
    # sharedNamePattern: '^(shared-|proxy$|pg0[0-9]$)'
```

The tab shows the period's cost and its monthly projection, unused capacity,
shared services, cost by resource, environment and node, a table per guest
(CSV export), cost per catalog **System** and **Component** (from the
`iswesolutions.com/proxmox-guests` annotation; a guest named by several
components is split evenly), and right-sizing hints with their monthly saving:
stopped guests holding disk, memory limits far above use, idle CPU allotments.
"How costs are calculated" lists every rate, where it came from, and capacity
against demand.

## Installation

```sh
yarn --cwd packages/app add @iswesolutions/plugin-monitoring
```

Add a route in `packages/app/src/App.tsx`:

```tsx
import { MonitoringPage } from '@iswesolutions/plugin-monitoring';

<Route path="/monitoring" element={<MonitoringPage />} />;
```

And, optionally, a sidebar entry in `packages/app/src/components/Root/Root.tsx`:

```tsx
import MonitorIcon from '@material-ui/icons/Timeline';

<SidebarItem icon={MonitorIcon} to="monitoring" text="Monitoring" />;
```

## Exports

- `monitoringPlugin`, `MonitoringPage`
- Types: `PrometheusMetric`, `ServiceHealth`, `GrafanaDashboard`,
  `SecurityAlert`, `CostSummary`

## Requirements

Backstage 1.51 or later (`@backstage/core-plugin-api` 1.12,
`@backstage/core-components` 0.18, `@backstage/plugin-catalog-react` 3), React 16.13–18, and React Router 6.
