import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Switch,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import GetAppIcon from '@material-ui/icons/GetApp';
import { Table, TableColumn } from '@backstage/core-components';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  computeCosts,
  costByCatalog,
  CostInputs,
  GroupCost,
  groupBy,
  GuestCost,
  Hint,
  HOURS_PER_MONTH,
  loadCostInputs,
  Period,
  PERIODS,
  readCostConfig,
  Resource,
  RESOURCES,
  rightSizing,
} from '../../services/costModel';
import { ElectricityPanel } from './ElectricityPanel';
import { useMonitoringSettings } from '../../services/settings';

const COLORS: Record<Resource, string> = {
  cpu: '#3f51b5',
  memory: '#00a3a3',
  storage: '#f29d38',
  network: '#8e5bd6',
  backup: '#5a8f3d',
  fixed: '#9e9e9e',
};
const LABELS: Record<Resource, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  storage: 'Storage',
  network: 'Network',
  backup: 'Backups',
  fixed: 'Fixed fee',
};

function money(currency: string) {
  let f: Intl.NumberFormat;
  try {
    f = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    f = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  }
  return (x: number) => f.format(Math.abs(x) < 0.005 ? 0 : x);
}
const n1 = (x?: number) => (x === undefined ? '' : x.toFixed(x < 10 ? 1 : 0));

const Stat = ({
  title,
  value,
  note,
}: {
  title: string;
  value: string;
  note?: string;
}) => (
  <Card style={{ height: '100%' }}>
    <CardContent>
      <Typography variant="overline" color="textSecondary">
        {title}
      </Typography>
      <Typography variant="h4">{value}</Typography>
      {note && (
        <Typography variant="caption" color="textSecondary">
          {note}
        </Typography>
      )}
    </CardContent>
  </Card>
);

function downloadCsv(rows: GuestCost[], currency: string, period: string) {
  const head = [
    'vmid',
    'name',
    'node',
    'kind',
    'env',
    'exists',
    'shared',
    'running_hours',
    'cpu_core_hours_billed',
    'memory_gib_hours_billed',
    'disk_gib',
    'network_gib',
    'backup_gib',
    ...RESOURCES.map(r => `${r}_${currency}`),
    `shared_overhead_${currency}`,
    `total_${currency}`,
    `per_month_${currency}`,
  ];
  const esc = (v: unknown) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [head.join(',')].concat(
    rows.map(r =>
      [
        r.vmid,
        r.name,
        r.node,
        r.kind,
        r.env,
        r.exists,
        r.shared,
        r.runningHours.toFixed(1),
        r.billed.cpuCoreHours.toFixed(2),
        r.billed.memoryGbHours.toFixed(2),
        r.diskGb.toFixed(2),
        r.billed.networkGb.toFixed(3),
        r.backupGb.toFixed(2),
        ...RESOURCES.map(k => r.cost[k].toFixed(4)),
        r.sharedOverhead.toFixed(4),
        r.total.toFixed(4),
        r.monthly.toFixed(4),
      ]
        .map(esc)
        .join(','),
    ),
  );
  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/csv' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `guest-costs-${period}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export const CostInsightsView = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const catalogApi = useApi(catalogApiRef);
  // app-config with the shared settings (Settings tab) on top
  const effective = useMonitoringSettings()?.config ?? configApi;
  const config = useMemo(() => readCostConfig(effective), [effective]);
  const [period, setPeriod] = useState<Period>('30d');
  const [spreadShared, setSpreadShared] = useState(false);
  const [inputs, setInputs] = useState<CostInputs | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [catalog, setCatalog] = useState<{
    components: GroupCost[];
    systems: GroupCost[];
    unassigned: number;
  }>();

  useEffect(() => {
    let cancelled = false;
    setInputs(undefined);
    setError(undefined);
    loadCostInputs({ discoveryApi, fetchApi, configApi }, period)
      .then(i => !cancelled && setInputs(i))
      .catch(e => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi, configApi, period]);

  const result = useMemo(
    () => (inputs ? computeCosts(inputs, config, { spreadShared }) : undefined),
    [inputs, config, spreadShared],
  );

  useEffect(() => {
    if (!result) return;
    costByCatalog(catalogApi, result)
      .then(setCatalog)
      .catch(() => setCatalog(undefined));
  }, [catalogApi, result]);

  if (error) {
    return (
      <Box p={3}>
        <Alert severity="error">
          Couldn't load usage from Prometheus: {error}. The costs use the same
          Grafana proxy as the Prometheus / Health tab.
        </Alert>
      </Box>
    );
  }
  if (!result) return <LinearProgress />;

  const fmt = money(config.currency);
  const scale =
    result.coveredHours > 0 ? HOURS_PER_MONTH / result.coveredHours : 0;
  const periodLabel = PERIODS.find(p => p.value === period)?.label ?? period;
  const pie = RESOURCES.filter(k => result.byResource[k] > 0.005).map(k => ({
    name: LABELS[k],
    key: k,
    value: Math.round(result.byResource[k] * 100) / 100,
  }));
  const barData = (groups: GroupCost[]) =>
    groups.slice(0, 12).map(g => ({
      name: g.key,
      ...Object.fromEntries(
        RESOURCES.map(k => [
          k,
          Math.round(g.byResource[k] * scale * 100) / 100,
        ]),
      ),
    }));
  const byEnv = groupBy(result.guests, g => g.env, scale);
  const byNode = groupBy(result.guests, g => g.node || '(gone)', scale);
  const hints: Hint[] = rightSizing(result);

  const guestColumns: TableColumn<GuestCost>[] = [
    {
      title: 'Guest',
      field: 'name',
      highlight: true,
      render: r => (
        <>
          {r.name}
          <Typography variant="caption" color="textSecondary" component="div">
            {r.kind} {r.vmid}
            {!r.exists && ' · deleted'}
            {r.shared && ' · shared service'}
          </Typography>
        </>
      ),
    },
    { title: 'Node', field: 'node' },
    { title: 'Env', field: 'env' },
    {
      title: 'Ran',
      field: 'runningHours',
      type: 'numeric',
      render: r =>
        `${Math.round(
          (100 * r.runningHours) / Math.max(result.coveredHours, 1),
        )}%`,
    },
    {
      title: 'CPU cores (used / allotted)',
      field: 'cpuUsedCoreHours',
      type: 'numeric',
      render: r =>
        r.runningHours
          ? `${(r.cpuUsedCoreHours / r.runningHours).toFixed(2)} / ${n1(
              r.cores ?? r.cpuAllocatedCoreHours / r.runningHours,
            )}`
          : '',
    },
    {
      title: 'Memory GiB (used / limit)',
      field: 'memoryUsedGbHours',
      type: 'numeric',
      render: r =>
        r.runningHours
          ? `${n1(r.memoryUsedGbHours / r.runningHours)} / ${n1(
              r.memoryLimitGb,
            )}`
          : n1(r.memoryLimitGb),
    },
    {
      title: 'Disk GiB',
      field: 'diskGb',
      type: 'numeric',
      render: r => n1(r.diskGb),
    },
    {
      title: 'Network GiB',
      field: 'billed.networkGb',
      type: 'numeric',
      render: r => n1(r.billed.networkGb),
    },
    ...RESOURCES.filter(k => k !== 'fixed' || result.rates.guestMonth > 0).map(
      (k): TableColumn<GuestCost> => ({
        title: LABELS[k],
        field: `cost.${k}`,
        type: 'numeric',
        render: r => fmt(r.cost[k]),
      }),
    ),
    ...(spreadShared
      ? [
          {
            title: 'Shared services',
            field: 'sharedOverhead',
            type: 'numeric',
            render: (r: GuestCost) => fmt(r.sharedOverhead),
          } as TableColumn<GuestCost>,
        ]
      : []),
    {
      title: `Total (${periodLabel.toLowerCase()})`,
      field: 'total',
      type: 'numeric',
      defaultSort: 'desc',
      render: r => <b>{fmt(r.total)}</b>,
    },
    {
      title: 'Per month',
      field: 'monthly',
      type: 'numeric',
      render: r => fmt(r.monthly),
    },
  ];

  const groupColumns = (title: string): TableColumn<GroupCost>[] => [
    { title, field: 'key', highlight: true },
    {
      title: 'Guests',
      field: 'guests',
      type: 'numeric',
      render: g => n1(g.guests),
    },
    ...RESOURCES.filter(k => k !== 'fixed' || result.rates.guestMonth > 0).map(
      (k): TableColumn<GroupCost> => ({
        title: LABELS[k],
        field: `byResource.${k}`,
        type: 'numeric',
        render: g => fmt(g.byResource[k] * scale),
      }),
    ),
    {
      title: 'Per month',
      field: 'monthly',
      type: 'numeric',
      defaultSort: 'desc',
      render: g => <b>{fmt(g.monthly)}</b>,
    },
  ];

  const cpuBasisText = {
    used: 'actually used',
    allocated: 'allotted',
    blend: `used, with ${
      config.cpuAllocatedWeight * 100
    }% weight on the cores allotted`,
  }[config.cpuBasis];
  type RateRow = { pool: string; unit: string; rate: number; from: string };
  const rateRows: RateRow[] = (
    [
      ['CPU', 'per core used, per month', 'cpuCoreMonth'],
      ['Memory', 'per GiB, per month', 'memoryGbMonth'],
      ['Storage', 'per GiB allotted, per month', 'storageGbMonth'],
      ['Network', 'per GiB in and out', 'networkGb'],
      ['Backups', 'per GiB on pbs01, per month', 'backupGbMonth'],
      ['Fixed fee', 'per guest, per month', 'guestMonth'],
    ] as const
  ).map(([pool, unit, k]) => ({
    pool,
    unit,
    rate: result.rates[k],
    from: result.rateSource[k],
  }));
  const coverage =
    result.coveredHours < result.periodHours - 1
      ? `Usage data covers ${Math.round(
          result.coveredHours,
        )} of the period's ${Math.round(
          result.periodHours,
        )} hours; per-month figures are scaled from those hours.`
      : undefined;

  return (
    <Box p={3}>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        mb={2}
        style={{ gap: 24 }}
      >
        <Typography variant="h4" style={{ flexGrow: 1 }}>
          Cost of guests (containers and VMs)
        </Typography>
        <FormControl variant="outlined" size="small" style={{ minWidth: 180 }}>
          <InputLabel id="cost-period">Period</InputLabel>
          <Select
            labelId="cost-period"
            label="Period"
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
          >
            {PERIODS.map(p => (
              <MenuItem key={p.value} value={p.value}>
                {p.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControlLabel
          control={
            <Switch
              checked={spreadShared}
              onChange={e => setSpreadShared(e.target.checked)}
              color="primary"
            />
          }
          label="Spread shared services over the other guests"
        />
        <Button
          variant="outlined"
          startIcon={<GetAppIcon />}
          onClick={() => downloadCsv(result.guests, config.currency, period)}
        >
          CSV
        </Button>
      </Box>

      {config.example && (
        <Alert severity="warning" style={{ marginBottom: 16 }}>
          These are <b>example rates</b>, not ISWE's real costs. Set{' '}
          <code>monitoring.costs</code> in app-config: either{' '}
          <code>monthlyInfrastructureCost</code> (what the cluster costs per
          month; rates are then derived from capacity) or explicit{' '}
          <code>rates</code>. See "How costs are calculated" below.
        </Alert>
      )}
      {coverage && (
        <Alert severity="info" style={{ marginBottom: 16 }}>
          {coverage}
        </Alert>
      )}

      <Grid container spacing={3} style={{ marginBottom: 16 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title={`Guests' cost, ${periodLabel.toLowerCase()}`}
            value={fmt(result.total)}
            note={`${result.guests.length} guests`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title="Per month at this rate"
            value={fmt(result.monthly)}
            note={`a year: ${fmt(result.monthly * 12)}`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          {result.unusedCapacityCost !== undefined ? (
            <Stat
              title="Unused capacity, per month"
              value={fmt(result.unusedCapacityCost * scale)}
              note={`${Math.round(
                (100 * result.unusedCapacityCost) /
                  Math.max(result.infrastructureCost ?? 1, 1),
              )}% of ${fmt(
                config.monthlyInfrastructureCost ?? 0,
              )} a month not taken up by guests`}
            />
          ) : (
            <Stat
              title="Running guests"
              value={String(
                result.guests.filter(g => g.runningHours > 0).length,
              )}
              note={`of ${result.guests.length}`}
            />
          )}
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title="Shared services, per month"
            value={fmt(result.sharedTotal * scale)}
            note={`${Math.round(
              (100 * result.sharedTotal) / Math.max(result.total, 0.01),
            )}% of the total${spreadShared ? ', spread over the others' : ''}`}
          />
        </Grid>
      </Grid>

      <Grid container spacing={3} style={{ marginBottom: 16 }}>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography variant="h6">By resource</Typography>
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={pie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                  >
                    {pie.map(p => (
                      <Cell key={p.key} fill={COLORS[p.key as Resource]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
        {[
          ['By environment, per month', byEnv],
          ['By node, per month', byNode],
        ].map(([title, groups]) => (
          <Grid item xs={12} md={4} key={title as string}>
            <Card>
              <CardContent>
                <Typography variant="h6">{title as string}</Typography>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={barData(groups as GroupCost[])}
                    layout="vertical"
                    margin={{ left: 16 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={80} />
                    <Tooltip formatter={(v: number) => fmt(v)} />
                    {RESOURCES.map(k => (
                      <Bar
                        key={k}
                        dataKey={k}
                        name={LABELS[k]}
                        stackId="a"
                        fill={COLORS[k]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <ElectricityPanel period={period} guests={result.guests} money={fmt} />

      <Box mb={3}>
        <Table<GuestCost>
          title="Per guest"
          subtitle="Running and stopped guests, and guests deleted during the period (billed for the time they existed). Stopped guests still pay for their disk."
          options={{
            paging: true,
            pageSize: 20,
            pageSizeOptions: [20, 50, 100],
            search: true,
            padding: 'dense',
          }}
          columns={guestColumns}
          data={result.guests}
        />
      </Box>

      {catalog &&
        (catalog.components.length > 0 || catalog.systems.length > 0) && (
          <Grid container spacing={3} style={{ marginBottom: 24 }}>
            <Grid item xs={12} md={6}>
              <Table<GroupCost>
                title="Per catalog System"
                subtitle={`From the components' iswesolutions.com/proxmox-guests annotation. Guests no component names: ${fmt(
                  catalog.unassigned * scale,
                )} a month.`}
                options={{ paging: false, search: false, padding: 'dense' }}
                columns={groupColumns('System')}
                data={catalog.systems}
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <Table<GroupCost>
                title="Per catalog Component"
                subtitle="A guest named by several components is split between them evenly."
                options={{
                  paging: true,
                  pageSize: 10,
                  search: true,
                  padding: 'dense',
                }}
                columns={groupColumns('Component')}
                data={catalog.components}
              />
            </Grid>
          </Grid>
        )}

      {hints.length > 0 && (
        <Box mb={3}>
          <Table<Hint>
            title="Right-sizing"
            subtitle="Estimated saving per month at the current rates. Check with the guest's owner first."
            options={{
              paging: true,
              pageSize: 10,
              search: false,
              padding: 'dense',
            }}
            columns={[
              { title: 'Guest', field: 'name', highlight: true },
              { title: 'ID', field: 'vmid' },
              { title: 'Finding', field: 'text' },
              {
                title: 'Saving per month',
                field: 'monthlySaving',
                type: 'numeric',
                defaultSort: 'desc',
                render: h => fmt(h.monthlySaving),
              },
            ]}
            data={hints}
          />
        </Box>
      )}

      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="h6">How costs are calculated</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Box>
            <Typography paragraph>
              Each guest pays for what it takes from five pools over the period,
              at the rates below. Usage comes from Proxmox through Prometheus
              (every minute; Prometheus keeps 30 days).
            </Typography>
            <ul>
              <li>
                <b>CPU:</b> core-hours {cpuBasisText}. Allotted cores are
                overcommitted (
                {Math.round(
                  result.guests.reduce((s, g) => s + (g.cores ?? 0), 0),
                )}{' '}
                allotted on {result.capacity.cores} host threads), so they
                aren't a fair measure.
              </li>
              <li>
                <b>Memory:</b> GiB-hours while running. Containers:{' '}
                {config.memoryBasis === 'blend'
                  ? `${(1 - config.memoryAllocatedWeight) * 100}% on use, ${
                      config.memoryAllocatedWeight * 100
                    }% on the limit`
                  : config.memoryBasis}
                . VMs:{' '}
                {config.vmMemoryBasis === 'allocated'
                  ? 'their full RAM (it is committed on the host while they run)'
                  : config.vmMemoryBasis}
                .
              </li>
              <li>
                <b>Storage:</b> GiB allotted, all period, whether the guest runs
                or not.
              </li>
              <li>
                <b>Network:</b> GiB{' '}
                {config.networkDirection === 'out'
                  ? 'sent'
                  : 'received and sent'}{' '}
                (all traffic, guest-to-guest included).
              </li>
              <li>
                <b>Backups:</b> pbs01's real use (
                {n1(result.capacity.backupUsedGb)} GiB) shared out by the size
                of each guest's newest backup.
              </li>
            </ul>
            <Table<RateRow>
              title="Rates"
              options={{
                paging: false,
                search: false,
                toolbar: false,
                padding: 'dense',
              }}
              columns={[
                { title: 'Pool', field: 'pool' },
                { title: 'Unit', field: 'unit' },
                {
                  title: 'Rate',
                  field: 'rate',
                  render: r => `${config.currency} ${r.rate.toFixed(4)}`,
                },
                { title: 'From', field: 'from' },
              ]}
              data={rateRows}
            />
            <Typography paragraph style={{ marginTop: 16 }}>
              <b>Capacity and demand</b> (average over the period, on the
              billing basis): CPU {n1(result.demand.cores)} of{' '}
              {result.capacity.cores} cores; memory {n1(result.demand.memoryGb)}{' '}
              of {n1(result.capacity.memoryGb)} GiB; disk{' '}
              {n1(result.demand.storageGb)} of {n1(result.capacity.storageGb)}{' '}
              GiB of thin pools.{' '}
              {config.monthlyInfrastructureCost !== undefined
                ? `Derived rates divide each pool's share of ${fmt(
                    config.monthlyInfrastructureCost,
                  )} a month by the larger of its capacity and its demand, so an overcommitted pool recovers exactly its share and no more; what guests don't take up is unused capacity. The network pool is shared out by traffic.`
                : 'Set monthlyInfrastructureCost to derive the rates from what the cluster costs, and to see unused capacity.'}
            </Typography>
            <Typography
              variant="body2"
              component="pre"
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {`# app-config.yaml
monitoring:
  costs:
    currency: ZMW
    monthlyInfrastructureCost: 50000      # hosting, hardware, power, licences, per month
    split: { cpu: 0.35, memory: 0.35, storage: 0.15, network: 0.1, backup: 0.05 }
    # rates: { cpuCoreMonth: 300, memoryGbMonth: 80, storageGbMonth: 2, networkGb: 1, backupGbMonth: 0.5, guestMonth: 0 }
    # cpuBasis: used | allocated | blend        memoryBasis: blend    vmMemoryBasis: allocated
    # sharedEnvironments: [shared]             sharedNamePattern: '^(shared-|proxy$|pg0[0-9]$)'`}
            </Typography>
          </Box>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};
