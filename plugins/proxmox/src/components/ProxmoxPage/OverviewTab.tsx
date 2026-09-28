import {
  Box,
  Card,
  CardContent,
  Grid,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@material-ui/core';
import { ProxmoxResources } from '@internal/plugin-proxmox-common';
import { percent, uptime } from './format';
import { StatusChip, UsageBar } from './parts';

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

export const OverviewTab = ({ data }: { data: ProxmoxResources }) => {
  const running = data.guests.filter(g => g.status === 'running').length;
  const stopped = data.guests.filter(
    g => g.status === 'stopped' && !g.template,
  ).length;

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
      </Grid>

      <Box mt={3}>
        <Typography variant="h6" gutterBottom>
          Nodes
        </Typography>
        <TableContainer component={Card}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Node</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>CPU</TableCell>
                <TableCell>Memory</TableCell>
                <TableCell>Uptime</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.nodes.map(n => (
                <TableRow key={n.node} hover>
                  <TableCell>
                    {n.uiUrl ? (
                      <Link href={n.uiUrl} target="_blank" rel="noopener">
                        {n.node}
                      </Link>
                    ) : (
                      n.node
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={n.status} />
                  </TableCell>
                  <TableCell>
                    {n.status === 'online'
                      ? `${percent(n.cpu)} of ${n.maxcpu} cores`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {n.status === 'online' ? (
                      <UsageBar
                        used={n.mem}
                        total={n.maxmem}
                        frac={n.maxmem ? n.mem / n.maxmem : 0}
                      />
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{uptime(n.uptime)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Box>
  );
};
