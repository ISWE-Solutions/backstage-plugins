# Monitoring plugin

A Backstage frontend plugin with one **Monitoring** page and four tabs:

| Tab | Shows |
| --- | --- |
| **Prometheus / Health** | Service health (status, uptime, response time, error rate) and key Prometheus metrics with 24-hour trend charts |
| **Grafana Dashboards** | A catalogue of Grafana dashboards with links to open them |
| **Security Insights** | Security alerts by severity, with the affected service and repository |
| **Cost Insights** | Infrastructure cost by category and service, with the month's trend |

> **Preview: sample data.** Every tab is built, but the data comes from
> `src/services/monitoringService.ts`, which returns fixed sample values
> (services such as OpenEMR and DHIS2, `https://grafana.example.org` links,
> `example-org/…` repositories). Nothing is fetched from Prometheus, Grafana,
> a security scanner or a billing source yet. Connecting them means replacing
> the methods of `MonitoringService` with calls to those systems, usually
> through a backend plugin or the Backstage proxy.

## Installation

```sh
yarn --cwd packages/app add @iswesolutions/plugin-monitoring
```

Add a route in `packages/app/src/App.tsx`:

```tsx
import { MonitoringPage } from '@iswesolutions/plugin-monitoring';

<Route path="/monitoring" element={<MonitoringPage />} />
```

And, optionally, a sidebar entry in `packages/app/src/components/Root/Root.tsx`:

```tsx
import MonitorIcon from '@material-ui/icons/Timeline';

<SidebarItem icon={MonitorIcon} to="monitoring" text="Monitoring" />
```

## Exports

- `monitoringPlugin`, `MonitoringPage`
- Types: `PrometheusMetric`, `ServiceHealth`, `GrafanaDashboard`,
  `SecurityAlert`, `CostSummary`

## Requirements

Backstage 1.51 or later (`@backstage/core-plugin-api` 1.12,
`@backstage/core-components` 0.18), React 16.13–18, and React Router 6.
