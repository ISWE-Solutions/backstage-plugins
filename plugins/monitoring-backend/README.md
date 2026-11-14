# Monitoring backend plugin

The backend of [`@iswesolutions/plugin-monitoring`](../monitoring): the
**shared settings** of its Settings tab (cost rates, electricity tariff, PUE,
CO₂ factor ...), kept in Backstage's database. A saved setting overrides the
frontend's app-config (`monitoring.<key>`); removing it goes back to
app-config.

| Route                          | Who                          | Does                                                                                                    |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/monitoring/settings` | every signed-in user         | `{ settings: { key: { value, updatedBy, updatedAt } }, keys, canEdit }`                                 |
| `PUT /api/monitoring/settings` | `monitoring.settings.update` | `{ changes: { key: value \| null } }`: saves, or removes with `null`; validated (ranges, currency code) |

Settings: `costs.currency`, `costs.monthlyInfrastructureCost`,
`costs.split.{cpu,memory,storage,network,backup}` (0 to 1),
`costs.rates.{cpuCoreMonth,memoryGbMonth,storageGbMonth,networkGb,backupGbMonth,guestMonth}`,
`costs.electricity.tariffPerKwh`, `costs.electricity.pue` (1 to 3),
`costs.electricity.co2KgPerKwh`.

## Installation

```sh
yarn --cwd packages/backend add @iswesolutions/plugin-monitoring-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@iswesolutions/plugin-monitoring-backend'));
```

The plugin registers the `monitoring.settings.update` permission. With the
community RBAC plugin, list it so roles can be given it:

```yaml
permission:
  rbac:
    pluginsWithPermission: [monitoring]
```

Super users have it already. The table `monitoring_settings` is created on
first start.
