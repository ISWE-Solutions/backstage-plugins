import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tab,
  Tabs,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { ProxmoxDisk, ProxmoxDiskSmart } from '@internal/plugin-proxmox-common';
import { proxmoxApiRef } from '../../services/proxmoxService';
import { bytes } from './format';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';
import { Sparkline } from './rates';

const COLUMNS_KEY = 'proxmox.disks.columns.v1';
const COLUMNS: ColumnDefinition[] = [
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'device', label: 'Device', defaultWidth: 130 },
  { id: 'model', label: 'Model', defaultWidth: 200 },
  { id: 'type', label: 'Type', defaultWidth: 90 },
  { id: 'size', label: 'Size', defaultWidth: 100 },
  { id: 'health', label: 'Health', defaultWidth: 110 },
  { id: 'wearout', label: 'Wearout', defaultWidth: 100 },
  { id: 'usage', label: 'Usage', defaultWidth: 170 },
];

const SMART_POLL_MS = 30_000;

const healthColor = (h?: string): string => {
  const v = (h ?? '').toUpperCase();
  if (v === 'PASSED' || v === 'OK') return '#2e7d32';
  if (v === 'FAILED') return '#c62828';
  return '#9e9e9e';
};

const useDetailStyles = makeStyles(theme => ({
  detail: {
    padding: theme.spacing(2),
    backgroundColor: theme.palette.background.default,
  },
  label: {
    display: 'block',
    color: theme.palette.text.secondary,
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  value: { fontFamily: 'monospace' },
}));

/** Expanded disk detail: Overview (SMART attribute cards) + History (temp). */
const DiskDetail = ({
  disk,
  clusterId,
}: {
  disk: ProxmoxDisk;
  clusterId: string;
}) => {
  const classes = useDetailStyles();
  const api = useApi(proxmoxApiRef);
  const [tab, setTab] = useState(0);
  const [smart, setSmart] = useState<ProxmoxDiskSmart>();
  const [error, setError] = useState<string>();
  const [temps, setTemps] = useState<number[]>([]);
  const tempsRef = useRef<number[]>([]);

  const poll = useCallback(async () => {
    try {
      const s = await api.getDiskSmart(disk.node, disk.devpath, clusterId);
      setSmart(s);
      setError(undefined);
      if (typeof s.temperature === 'number') {
        tempsRef.current = [...tempsRef.current, s.temperature].slice(-40);
        setTemps(tempsRef.current);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, disk.node, disk.devpath, clusterId]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, SMART_POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const field = (label: string, value: React.ReactNode) => (
    <Grid item xs={6} sm={4} md={3}>
      <span className={classes.label}>{label}</span>
      <span className={classes.value}>{value}</span>
    </Grid>
  );

  return (
    <Box className={classes.detail}>
      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        indicatorColor="primary"
        textColor="primary"
      >
        <Tab label="Overview" />
        <Tab label="History" />
      </Tabs>
      <Box mt={2}>
        {tab === 0 ? (
          <>
            <Grid container spacing={2}>
              {field(
                'Health',
                <Chip
                  size="small"
                  label={disk.health ?? smart?.health ?? 'unknown'}
                  style={{
                    height: 18,
                    backgroundColor: healthColor(disk.health ?? smart?.health),
                    color: '#fff',
                  }}
                />,
              )}
              {field(
                'Temperature',
                smart?.temperature !== undefined
                  ? `${smart.temperature} °C`
                  : '—',
              )}
              {field(
                'Wearout',
                disk.wearout !== undefined ? `${disk.wearout}%` : '—',
              )}
              {field(
                'Power-on hours',
                smart?.powerOnHours !== undefined
                  ? smart.powerOnHours.toLocaleString()
                  : '—',
              )}
              {field('Size', bytes(disk.size))}
              {field('Type', disk.type)}
              {field('Model', disk.model ?? '—')}
              {field('Serial', disk.serial ?? '—')}
              {field('Usage', disk.used ?? '—')}
              {disk.rpm ? field('RPM', disk.rpm.toLocaleString()) : null}
            </Grid>

            {error && (
              <Box mt={2}>
                <Alert severity="warning">SMART unavailable: {error}</Alert>
              </Box>
            )}
            {smart && smart.attributes.length > 0 && (
              <Box mt={2}>
                <span className={classes.label}>SMART attributes</span>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Attribute</TableCell>
                      <TableCell align="right">Value</TableCell>
                      <TableCell align="right">Worst</TableCell>
                      <TableCell align="right">Threshold</TableCell>
                      <TableCell align="right">Raw</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {smart.attributes.map(a => (
                      <TableRow key={a.name}>
                        <TableCell>{a.name}</TableCell>
                        <TableCell align="right">{a.value ?? '—'}</TableCell>
                        <TableCell align="right">{a.worst ?? '—'}</TableCell>
                        <TableCell align="right">
                          {a.threshold ?? '—'}
                        </TableCell>
                        <TableCell align="right">{a.raw ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
            {smart && smart.attributes.length === 0 && smart.text && (
              <Box mt={2}>
                <span className={classes.label}>SMART output</span>
                <pre
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                  }}
                >
                  {smart.text}
                </pre>
              </Box>
            )}
          </>
        ) : (
          <Box>
            <span className={classes.label}>Temperature (this session)</span>
            {temps.length >= 2 ? (
              <>
                <Sparkline
                  values={temps}
                  color="#ef6c00"
                  width={420}
                  height={80}
                />
                <Typography variant="body2" style={{ fontFamily: 'monospace' }}>
                  {temps[temps.length - 1]} °C
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="textSecondary">
                {smart?.temperature !== undefined
                  ? 'Temperature history builds while this row stays open.'
                  : 'This disk does not report a SMART temperature.'}
              </Typography>
            )}
            <Typography
              variant="caption"
              color="textSecondary"
              component="div"
              style={{ marginTop: 8 }}
            >
              Persisted time-series history is not stored server-side; readings
              are polled live every 30s while expanded.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export const DisksTab = ({ clusterId }: { clusterId: string }) => {
  const api = useApi(proxmoxApiRef);
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);
  const [disks, setDisks] = useState<ProxmoxDisk[]>();
  const [error, setError] = useState<Error>();
  const [q, setQ] = useState('');
  const [nodeFilter, setNodeFilter] = useState('all');

  useEffect(() => {
    let active = true;
    setDisks(undefined);
    setError(undefined);
    api
      .getDisks(clusterId)
      .then(r => active && setDisks(r.disks))
      .catch(
        e => active && setError(e instanceof Error ? e : new Error(String(e))),
      );
    return () => {
      active = false;
    };
  }, [api, clusterId]);

  const nodeOptions = useMemo(
    () => Array.from(new Set((disks ?? []).map(d => d.node))).sort(),
    [disks],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (disks ?? []).filter(d => {
      if (nodeFilter !== 'all' && d.node !== nodeFilter) return false;
      if (!needle) return true;
      return (
        d.devpath.toLowerCase().includes(needle) ||
        (d.model ?? '').toLowerCase().includes(needle) ||
        (d.serial ?? '').toLowerCase().includes(needle) ||
        d.node.toLowerCase().includes(needle) ||
        (d.used ?? '').toLowerCase().includes(needle)
      );
    });
  }, [disks, q, nodeFilter]);

  const cellTitle = (id: string, d: ProxmoxDisk): string => {
    switch (id) {
      case 'node':
        return d.node;
      case 'device':
        return d.devpath;
      case 'model':
        return d.model ?? '';
      case 'type':
        return d.type;
      case 'size':
        return bytes(d.size);
      case 'health':
        return d.health ?? 'unknown';
      case 'wearout':
        return d.wearout !== undefined ? `${d.wearout}%` : '';
      case 'usage':
        return d.used ?? '';
      default:
        return '';
    }
  };

  const renderCell = (id: string, d: ProxmoxDisk) => {
    switch (id) {
      case 'device':
        return <span style={{ fontFamily: 'monospace' }}>{d.devpath}</span>;
      case 'type':
        return (
          <Chip
            size="small"
            label={d.type.toUpperCase()}
            style={{ height: 18 }}
          />
        );
      case 'size':
        return bytes(d.size);
      case 'health':
        return (
          <Chip
            size="small"
            label={d.health ?? 'unknown'}
            style={{
              height: 18,
              backgroundColor: healthColor(d.health),
              color: '#fff',
            }}
          />
        );
      case 'wearout':
        return d.wearout !== undefined ? `${d.wearout}%` : '—';
      default:
        return cellTitle(id, d) || '-';
    }
  };

  if (error) {
    return (
      <Alert severity="error">Failed to load disks: {error.message}</Alert>
    );
  }
  if (!disks) return <Progress />;
  if (disks.length === 0) {
    return (
      <Card>
        <CardContent>
          <Typography variant="body2" color="textSecondary">
            No physical disks reported. This needs the API token to allow
            reading node disks (a PVEAuditor token on /nodes covers it).
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Box>
      <Box
        display="flex"
        alignItems="center"
        style={{ gap: 12 }}
        mb={2}
        flexWrap="wrap"
      >
        <TextField
          size="small"
          variant="outlined"
          label="Search device, model, serial, node"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          variant="outlined"
          label="Node"
          value={nodeFilter}
          onChange={e => setNodeFilter(e.target.value)}
          style={{ minWidth: 130 }}
        >
          <MenuItem value="all">All nodes</MenuItem>
          {nodeOptions.map(n => (
            <MenuItem key={n} value={n}>
              {n}
            </MenuItem>
          ))}
        </TextField>
        <Box flexGrow={1} />
        <ColumnsMenuButton
          id="proxmox-disks"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>
      <ManagedTable
        settings={columns}
        rows={rows}
        rowKey={d => d.id}
        renderCell={renderCell}
        cellTitle={cellTitle}
        align={{ size: 'right', wearout: 'right' }}
        renderDetail={d => <DiskDetail disk={d} clusterId={clusterId} />}
      />
    </Box>
  );
};
