import { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Grid,
  Link,
  MenuItem,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import {
  ProxmoxGuest,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { bytes, percent, uptime } from './format';
import { StatusChip, UsageBar } from './parts';

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
  value: {
    fontFamily: 'monospace',
  },
}));

const GuestDetail = ({ g }: { g: ProxmoxGuest }) => {
  const classes = useDetailStyles();
  const field = (label: string, value: React.ReactNode) => (
    <Grid item xs={6} sm={4} md={3}>
      <span className={classes.label}>{label}</span>
      <span className={classes.value}>{value}</span>
    </Grid>
  );
  const running = g.status === 'running';
  return (
    <Box className={classes.detail}>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>CPU</span>
          <UsageBar
            used={running ? g.cpu * g.maxcpu : 0}
            total={g.maxcpu}
            frac={running ? g.cpu : 0}
            width={200}
          />
          <Typography variant="caption" color="textSecondary">
            {running ? `${percent(g.cpu)} of ${g.maxcpu} cores` : 'stopped'}
          </Typography>
        </Grid>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>Memory</span>
          {g.maxmem ? (
            <UsageBar
              used={g.mem}
              total={g.maxmem}
              frac={g.mem / g.maxmem}
              width={200}
            />
          ) : (
            <span className={classes.value}>—</span>
          )}
        </Grid>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>Disk</span>
          {g.maxdisk ? (
            <UsageBar
              used={g.disk}
              total={g.maxdisk}
              frac={g.maxdisk ? g.disk / g.maxdisk : 0}
              width={200}
            />
          ) : (
            <span className={classes.value}>—</span>
          )}
        </Grid>
        {field('VMID', g.vmid)}
        {field('Type', g.type === 'lxc' ? 'LXC container' : 'QEMU VM')}
        {field('Node', g.node)}
        {field('Uptime', running ? uptime(g.uptime) : '—')}
        {field('Net in', bytes(g.netin))}
        {field('Net out', bytes(g.netout))}
        {field('Disk read', bytes(g.diskread))}
        {field('Disk write', bytes(g.diskwrite))}
        {g.pool && field('Pool', g.pool)}
        {field(
          'Tags',
          g.tags.length
            ? g.tags.map(t => (
                <Chip
                  key={t}
                  size="small"
                  label={t}
                  style={{ marginRight: 4, height: 18 }}
                />
              ))
            : '—',
        )}
        {g.uiUrl &&
          field(
            'Console',
            <Link href={g.uiUrl} target="_blank" rel="noopener">
              Open in Proxmox
            </Link>,
          )}
      </Grid>
    </Box>
  );
};
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';

type Filter = 'all' | 'running' | 'stopped';

const COLUMNS_KEY = 'proxmox.guests.columns.v1';
const COLUMNS: ColumnDefinition[] = [
  { id: 'vmid', label: 'VMID', defaultWidth: 90 },
  { id: 'name', label: 'Name', defaultWidth: 200 },
  { id: 'type', label: 'Type', defaultWidth: 80 },
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'status', label: 'Status', defaultWidth: 110 },
  { id: 'cpu', label: 'CPU', defaultWidth: 90 },
  { id: 'memory', label: 'Memory', defaultWidth: 180 },
  { id: 'uptime', label: 'Uptime', defaultWidth: 110 },
  { id: 'tags', label: 'Tags', defaultWidth: 160 },
];

export const GuestsTab = ({ data }: { data: ProxmoxResources }) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.guests.filter((g: ProxmoxGuest) => {
      if (filter === 'running' && g.status !== 'running') return false;
      if (filter === 'stopped' && (g.status !== 'stopped' || g.template))
        return false;
      if (!needle) return true;
      return (
        g.name.toLowerCase().includes(needle) ||
        String(g.vmid).includes(needle) ||
        g.node.toLowerCase().includes(needle) ||
        g.tags.some(t => t.toLowerCase().includes(needle))
      );
    });
  }, [data.guests, q, filter]);

  const cellTitle = (id: string, g: ProxmoxGuest): string => {
    switch (id) {
      case 'vmid':
        return String(g.vmid);
      case 'name':
        return g.template ? `${g.name} (template)` : g.name;
      case 'type':
        return g.type === 'lxc' ? 'LXC' : 'VM';
      case 'node':
        return g.node;
      case 'status':
        return g.status;
      case 'cpu':
        return g.status === 'running' ? percent(g.cpu) : '';
      case 'memory':
        return g.status === 'running' && g.maxmem
          ? `${percent(g.mem / g.maxmem)}`
          : '';
      case 'uptime':
        return uptime(g.uptime);
      case 'tags':
        return g.tags.join(', ');
      default:
        return '';
    }
  };

  const renderCell = (id: string, g: ProxmoxGuest) => {
    switch (id) {
      case 'name':
        return (
          <>
            {g.uiUrl ? (
              <Link href={g.uiUrl} target="_blank" rel="noopener">
                {g.name}
              </Link>
            ) : (
              g.name
            )}
            {g.template && (
              <Chip
                size="small"
                label="template"
                style={{ marginLeft: 6, height: 18 }}
              />
            )}
          </>
        );
      case 'type':
        return g.type === 'lxc' ? 'LXC' : 'VM';
      case 'status':
        return <StatusChip status={g.status} />;
      case 'cpu':
        return g.status === 'running' ? percent(g.cpu) : '—';
      case 'memory':
        return g.status === 'running' && g.maxmem ? (
          <UsageBar
            used={g.mem}
            total={g.maxmem}
            frac={g.mem / g.maxmem}
            width={140}
          />
        ) : (
          '—'
        );
      case 'uptime':
        return uptime(g.uptime);
      case 'tags':
        return (
          <>
            {g.tags.map(t => (
              <Chip
                key={t}
                size="small"
                label={t}
                style={{ marginRight: 4, height: 18 }}
              />
            ))}
          </>
        );
      default:
        return cellTitle(id, g) || '-';
    }
  };

  return (
    <Box>
      <Box display="flex" style={{ gap: 16 }} mb={2} flexWrap="wrap">
        <TextField
          size="small"
          variant="outlined"
          label="Search name, VMID, node, tag"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          variant="outlined"
          label="Show"
          value={filter}
          onChange={e => setFilter(e.target.value as Filter)}
          style={{ minWidth: 140 }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="running">Running</MenuItem>
          <MenuItem value="stopped">Stopped</MenuItem>
        </TextField>
        <Box flexGrow={1} />
        <ColumnsMenuButton
          id="proxmox-guests"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>
      <ManagedTable
        settings={columns}
        rows={rows}
        rowKey={g => g.id}
        renderCell={renderCell}
        cellTitle={cellTitle}
        align={{ vmid: 'right' }}
        renderDetail={g => <GuestDetail g={g} />}
      />
    </Box>
  );
};
