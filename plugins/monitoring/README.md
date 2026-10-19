# Monitoring plugin

A Backstage frontend plugin with one **Monitoring** page and four tabs:

| Tab                     | Shows                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prometheus / Health** | **Live:** catalog Components with their site check, 24-hour uptime, response time, certificate expiry, and CPU and memory, from Prometheus |
| **Grafana Dashboards**  | A catalogue of Grafana dashboards with links to open them                                                                                  |
| **Security Insights**   | Security alerts by severity, with the affected service and repository                                                                      |
| **Cost Insights**       | Infrastructure cost by category and service, with the month's trend                                                                        |

> **System Health is live; the other tabs are sample data.** Grafana
> Dashboards, Security Insights and Cost Insights still come from
> `src/services/monitoringService.ts`, which returns fixed sample values
> (`https://grafana.example.org` links, `example-org/…` repositories).

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
