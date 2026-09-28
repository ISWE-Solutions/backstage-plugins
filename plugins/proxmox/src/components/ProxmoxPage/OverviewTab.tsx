import {
  Box,
  Card,
  CardContent,
  Grid,
  Link,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { ProxmoxNode, ProxmoxResources } from '@internal/plugin-proxmox-common';
import { bytes, percent, uptime } from './format';
import { StatusChip, UsageBar } from './parts';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <Card>
    <CardContent>
      <Typography variant="h4">{value}</Typography>
      <Typography variant="body2" color="textSecondary">
        {label}
      </Typography>
    </CardContent>
  </Card>
);

const NODE_COLUMNS_KEY = 'proxmox.nodes.columns.v1';
const NODE_COLUMNS: ColumnDefinition[] = [
  { id: 'node', label: 'Node', defaultWidth: 160 },
  { id: 'status', label: 'Status', defaultWidth: 110 },
  { id: 'cpu', label: 'CPU', defaultWidth: 200 },
  { id: 'memory', label: 'Memory', defaultWidth: 220 },
  { id: 'uptime', label: 'Uptime', defaultWidth: 120 },
];

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
    marginBottom: 4,
  },
}));

const NodeDetail = ({
  node,
  data,
}: {
  node: ProxmoxNode;
  data: ProxmoxResources;
}) => {
  const classes = useDetailStyles();
  const guests = data.guests.filter(g => g.node === node.node && !g.template);
  const running = guests.filter(g => g.status === 'running').length;
  const vms = guests.filter(g => g.type === 'qemu').length;
  const cts = guests.filter(g => g.type === 'lxc').length;
  const storage = data.storage.filter(s => s.node === node.node);

  return (
    <Box className={classes.detail}>
      <Grid container spacing={3}>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>CPU</span>
          {node.status === 'online' ? (
            <>
              <UsageBar
                used={node.cpu * node.maxcpu}
                total={node.maxcpu}
                frac={node.cpu}
                width={220}
              />
              <Typography variant="caption" color="textSecondary">
                {percent(node.cpu)} of {node.maxcpu} cores
              </Typography>
            </>
          ) : (
            '—'
          )}
        </Grid>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>Memory</span>
          {node.status === 'online' && node.maxmem ? (
            <UsageBar
              used={node.mem}
              total={node.maxmem}
              frac={node.mem / node.maxmem}
              width={220}
            />
          ) : (
            '—'
          )}
        </Grid>
        <Grid item xs={12} sm={4}>
          <span className={classes.label}>Guests</span>
          <Typography variant="body2">
            {guests.length} total · {running} running · {vms} VM
            {vms === 1 ? '' : 's'} · {cts} LXC
          </Typography>
          <Box mt={1}>
            <span className={classes.label}>Uptime</span>
            <Typography variant="body2">{uptime(node.uptime)}</Typography>
          </Box>
        </Grid>
        <Grid item xs={12}>
          <span className={classes.label}>Storage on {node.node}</span>
          {storage.length === 0 ? (
            <Typography variant="body2" color="textSecondary">
              No storage reported for this node.
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {storage.map(s => (
                <Grid item xs={12} sm={6} md={4} key={s.id}>
                  <Typography
                    variant="body2"
                    style={{ fontFamily: 'monospace' }}
                  >
                    {s.storage}
                    {s.shared ? ' (shared)' : ''}
                  </Typography>
                  {s.total ? (
                    <UsageBar
                      used={s.used}
                      total={s.total}
                      frac={s.usage}
                      width={200}
                    />
                  ) : (
                    '—'
                  )}
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>
      </Grid>
    </Box>
  );
};

export const OverviewTab = ({ data }: { data: ProxmoxResources }) => {
  const nodeColumns = useColumnSettings(NODE_COLUMNS_KEY, NODE_COLUMNS);
  const running = data.guests.filter(g => g.status === 'running').length;
  const stopped = data.guests.filter(
    g => g.status === 'stopped' && !g.template,
  ).length;

  const online = data.nodes.filter(n => n.status === 'online');
  const vcpus = online.reduce((s, n) => s + n.maxcpu, 0);
  const memTotal = online.reduce((s, n) => s + n.maxmem, 0);
  // Sum storage capacity, de-duplicating shared pools that appear on every node.
  const seen = new Set<string>();
  const storageTotal = data.storage.reduce((s, st) => {
    const key = st.shared ? st.storage : st.id;
    if (seen.has(key)) return s;
    seen.add(key);
    return s + st.total;
  }, 0);

  const cellTitle = (id: string, n: ProxmoxNode): string => {
    switch (id) {
      case 'node':
        return n.node;
      case 'status':
        return n.status;
      case 'cpu':
        return n.status === 'online'
          ? `${percent(n.cpu)} of ${n.maxcpu} cores`
          : '';
      case 'memory':
        return n.status === 'online' && n.maxmem
          ? percent(n.mem / n.maxmem)
          : '';
      case 'uptime':
        return uptime(n.uptime);
      default:
        return '';
    }
  };

  const renderCell = (id: string, n: ProxmoxNode) => {
    switch (id) {
      case 'node':
        return n.uiUrl ? (
          <Link
            href={n.uiUrl}
            target="_blank"
            rel="noopener"
            onClick={e => e.stopPropagation()}
          >
            {n.node}
          </Link>
        ) : (
          n.node
        );
      case 'status':
        return <StatusChip status={n.status} />;
      case 'cpu':
        return n.status === 'online'
          ? `${percent(n.cpu)} of ${n.maxcpu} cores`
          : '—';
      case 'memory':
        return n.status === 'online' && n.maxmem ? (
          <UsageBar used={n.mem} total={n.maxmem} frac={n.mem / n.maxmem} />
        ) : (
          '—'
        );
      case 'uptime':
        return uptime(n.uptime);
      default:
        return cellTitle(id, n) || '-';
    }
  };

  return (
    <Box>
      <Grid container spacing={2}>
        <Grid item xs={6} sm={3}>
          <Stat
            label={`Nodes online${
              data.cluster.name ? ` · ${data.cluster.name}` : ''
            }`}
            value={`${data.cluster.nodesOnline}/${data.cluster.nodesTotal}`}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat label="Guests running" value={running} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat label="Guests stopped" value={stopped} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat
            label="Quorum"
            value={
              data.cluster.quorate === undefined
                ? '—'
                : data.cluster.quorate
                ? 'OK'
                : 'LOST'
            }
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat label="Total vCPUs" value={vcpus} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat label="Total memory" value={bytes(memTotal)} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat label="Storage capacity" value={bytes(storageTotal)} />
        </Grid>
      </Grid>

      <Box mt={3}>
        <Box display="flex" alignItems="center" mb={1}>
          <Typography variant="h6">Nodes</Typography>
          <Box flexGrow={1} />
          <ColumnsMenuButton
            id="proxmox-nodes"
            columns={NODE_COLUMNS}
            settings={nodeColumns}
          />
        </Box>
        <ManagedTable
          settings={nodeColumns}
          rows={data.nodes}
          rowKey={n => n.node}
          renderCell={renderCell}
          cellTitle={cellTitle}
          renderDetail={n => <NodeDetail node={n} data={data} />}
        />
      </Box>
    </Box>
  );
};
