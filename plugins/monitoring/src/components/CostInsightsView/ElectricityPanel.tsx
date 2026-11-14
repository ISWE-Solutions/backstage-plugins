import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Grid,
  LinearProgress,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { Table, TableColumn } from '@backstage/core-components';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { GuestUsage, Period } from '../../services/costModel';
import {
  computeElectricity,
  ElectricityResult,
  GuestEnergy,
  loadNodePower,
  NodePower,
  readElectricityConfig,
} from '../../services/electricity';
import { useMonitoringSettings } from '../../services/settings';

type NodeRow = ElectricityResult['nodes'][number];

const kwh = (x: number) =>
  `${x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString()} kWh`;
const watts = (x?: number) => (x === undefined ? '' : `${Math.round(x)} W`);

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
      <Typography variant="h5">{value}</Typography>
      {note && (
        <Typography variant="caption" color="textSecondary">
          {note}
        </Typography>
      )}
    </CardContent>
  </Card>
);

/**
 * Electricity of the nodes (BMC readings) and each guest's share. Shown beside the guests' costs, not
 * added to them: the hosting fee may already include power.
 */
export const ElectricityPanel = ({
  period,
  guests,
  money,
}: {
  period: Period;
  guests: GuestUsage[];
  money: (x: number) => string;
}) => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const effective = useMonitoringSettings()?.config ?? configApi;
  const config = useMemo(() => readElectricityConfig(effective), [effective]);
  const [nodes, setNodes] = useState<NodePower[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setNodes(undefined);
    setError(undefined);
    loadNodePower({ discoveryApi, fetchApi, configApi }, period)
      .then(n => !cancelled && setNodes(n))
      .catch(e => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi, configApi, period]);

  const result = useMemo(
    () => (nodes ? computeElectricity(nodes, guests, config) : undefined),
    [nodes, guests, config],
  );

  const header = (
    <Typography variant="h5" gutterBottom>
      Electricity
    </Typography>
  );
  if (error) {
    return (
      <Box mb={3}>
        {header}
        <Alert severity="error">
          Couldn't load the nodes' power readings: {error}
        </Alert>
      </Box>
    );
  }
  if (!result) {
    return (
      <Box mb={3}>
        {header}
        <LinearProgress />
      </Box>
    );
  }
  if (result.nodes.length === 0) {
    return (
      <Box mb={3}>
        {header}
        <Alert severity="info">
          No power readings for this period. They come from node-power.py on
          each Proxmox node (the BMC's power sensors), every minute.
        </Alert>
      </Box>
    );
  }

  const covered = Math.min(...result.nodes.map(n => n.coveredHours));
  const tariff = config.tariffPerKwh;
  const pueNote = config.pue !== 1 ? ` at the meter (PUE ${config.pue})` : '';

  const nodeColumns: TableColumn<NodeRow>[] = [
    { title: 'Node', field: 'node', highlight: true },
    {
      title: 'Average',
      field: 'averageW',
      type: 'numeric',
      render: n => watts(n.averageW),
    },
    {
      title: 'Peak',
      field: 'peakW',
      type: 'numeric',
      render: n => watts(n.peakW),
    },
    {
      title: 'Idle (est.)',
      field: 'idleW',
      type: 'numeric',
      render: n => watts(n.idleW),
    },
    {
      title: 'CPUs and memory',
      field: 'cpuMemoryW',
      type: 'numeric',
      render: n => watts(n.cpuMemoryW),
    },
    {
      title: 'Energy, period',
      field: 'kwh',
      type: 'numeric',
      render: n => kwh(n.kwh),
    },
    {
      title: `Per month${pueNote}`,
      field: 'monthlyKwh',
      type: 'numeric',
      defaultSort: 'desc',
      render: n => kwh(n.monthlyKwh),
    },
    ...(tariff !== undefined
      ? [
          {
            title: 'Cost per month',
            field: 'monthlyCost',
            type: 'numeric',
            render: (n: NodeRow) => money(n.monthlyCost ?? 0),
          } as TableColumn<NodeRow>,
        ]
      : []),
    {
      title: 'Power supplies (AC input)',
      field: 'psuVolts',
      render: n =>
        Object.entries(n.psuVolts)
          .sort()
          .map(([psu, v]) =>
            v < 100 ? `PSU ${psu}: NO INPUT` : `PSU ${psu}: ${Math.round(v)} V`,
          )
          .join(' · '),
    },
    {
      title: 'Inlet',
      field: 'inletC',
      type: 'numeric',
      render: n => (n.inletC === undefined ? '' : `${n.inletC} °C`),
    },
  ];
  const guestColumns: TableColumn<GuestEnergy>[] = [
    { title: 'Guest', field: 'name', highlight: true },
    { title: 'ID', field: 'vmid' },
    { title: 'Node', field: 'node' },
    { title: 'Env', field: 'env' },
    {
      title: `Per month${pueNote}`,
      field: 'monthlyKwh',
      type: 'numeric',
      defaultSort: 'desc',
      render: g => kwh(g.monthlyKwh),
    },
    {
      title: 'Average',
      field: 'kwh',
      type: 'numeric',
      render: g => watts((g.monthlyKwh * 1000) / 730 / config.pue),
    },
    ...(tariff !== undefined
      ? [
          {
            title: 'Cost per month',
            field: 'monthlyCost',
            type: 'numeric',
            render: (g: GuestEnergy) => money(g.monthlyCost ?? 0),
          } as TableColumn<GuestEnergy>,
        ]
      : []),
  ];

  return (
    <Box mb={3}>
      {header}
      {result.psuWithoutInput.length > 0 && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          <b>No AC input:</b> {result.psuWithoutInput.join(', ')}. That server
          runs on its other power supply, without redundancy: check the supply's
          cable and feed.
        </Alert>
      )}
      {tariff === undefined && (
        <Alert severity="info" style={{ marginBottom: 16 }}>
          Energy only: set{' '}
          <code>monitoring.costs.electricity.tariffPerKwh</code> (and{' '}
          <code>pue</code> for cooling) to see what it costs. Electricity is
          shown here, not added to the guests' costs above.
        </Alert>
      )}
      <Grid container spacing={3} style={{ marginBottom: 16 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title="Average draw, all nodes"
            value={watts(result.totals.averageW)}
            note={`over ${Math.round(covered)} h of readings`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title={`Energy per month${pueNote}`}
            value={kwh(result.totals.monthlyKwh)}
            note={`${kwh(result.totals.kwh)} in this period (IT load)`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title="Electricity per month"
            value={
              result.totals.monthlyCost !== undefined
                ? money(result.totals.monthlyCost)
                : 'set a tariff'
            }
            note={
              tariff !== undefined ? `at ${money(tariff)} per kWh` : undefined
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            title="CO₂ per month"
            value={
              result.totals.monthlyCo2Kg !== undefined
                ? `${Math.round(
                    result.totals.monthlyCo2Kg,
                  ).toLocaleString()} kg`
                : '–'
            }
            note={
              config.co2KgPerKwh !== undefined
                ? `at ${config.co2KgPerKwh} kg per kWh`
                : 'set co2KgPerKwh'
            }
          />
        </Grid>
      </Grid>
      <Box mb={2}>
        <Table<NodeRow>
          title="Per node"
          subtitle="Wall power from each server's BMC every minute; CPUs and memory from Intel RAPL. Idle is the period's 5th percentile."
          options={{ paging: false, search: false, padding: 'dense' }}
          columns={nodeColumns}
          data={result.nodes}
        />
      </Box>
      <Table<GuestEnergy>
        title="Per guest"
        subtitle="Each node's energy above idle shared out by CPU used, its idle energy by memory used, over the period."
        options={{
          paging: true,
          pageSize: 10,
          pageSizeOptions: [10, 25, 100],
          search: true,
          padding: 'dense',
        }}
        columns={guestColumns}
        data={result.guests}
      />
    </Box>
  );
};
