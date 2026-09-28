import { useMemo } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  makeStyles,
} from '@material-ui/core';
import StorageIcon from '@material-ui/icons/Storage';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import ErrorOutlineIcon from '@material-ui/icons/ErrorOutline';
import DnsIcon from '@material-ui/icons/Dns';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import SettingsIcon from '@material-ui/icons/Settings';
import { Link as RouterLink } from 'react-router-dom';
import { DHIS2Instance } from '../types';

const useStyles = makeStyles(theme => ({
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing(2),
    height: '100%',
  },
  statIcon: { fontSize: 36, marginBottom: theme.spacing(1) },
  statValue: { fontSize: '2rem', fontWeight: 600, lineHeight: 1 },
  statLabel: { marginTop: theme.spacing(0.5), textAlign: 'center' },
  section: { marginTop: theme.spacing(3) },
  linkCard: { padding: theme.spacing(2), height: '100%' },
}));

const Stat = ({
  icon,
  color,
  value,
  label,
}: {
  icon: React.ReactNode;
  color: string;
  value: React.ReactNode;
  label: string;
}) => {
  const classes = useStyles();
  return (
    <Card className={classes.statCard}>
      <Box className={classes.statIcon} style={{ color }}>
        {icon}
      </Box>
      <Typography className={classes.statValue}>{value}</Typography>
      <Typography
        variant="subtitle2"
        color="textSecondary"
        className={classes.statLabel}
      >
        {label}
      </Typography>
    </Card>
  );
};

interface Props {
  instances: DHIS2Instance[];
}

/**
 * DHIS2 plugin dashboard: a summary of the managed DHIS2 estate (instance
 * counts, distribution by node and version) plus quick links to cluster
 * monitoring (the Proxmox plugin) and the plugin's settings.
 */
export const DHIS2DashboardPanel = ({ instances }: Props) => {
  const classes = useStyles();

  const stats = useMemo(() => {
    const by = (s: DHIS2Instance['status']) =>
      instances.filter(i => i.status === s).length;
    const nodes = new Map<string, { total: number; running: number }>();
    const versions = new Map<string, number>();
    for (const i of instances) {
      const n = nodes.get(i.node) ?? { total: 0, running: 0 };
      n.total += 1;
      if (i.status === 'running') n.running += 1;
      nodes.set(i.node, n);
      if (i.version)
        versions.set(i.version, (versions.get(i.version) ?? 0) + 1);
    }
    return {
      total: instances.length,
      running: by('running'),
      stopped: by('stopped'),
      errored: by('error') + by('provisioning'),
      nodes: [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      versions: [...versions.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [instances]);

  return (
    <Box>
      <Grid container spacing={3} alignItems="stretch">
        <Grid item xs={6} sm={4} md={3} lg>
          <Stat
            icon={<StorageIcon fontSize="inherit" />}
            color="#1976d2"
            value={stats.total}
            label="Total instances"
          />
        </Grid>
        <Grid item xs={6} sm={4} md={3} lg>
          <Stat
            icon={<PlayArrowIcon fontSize="inherit" />}
            color="#4caf50"
            value={stats.running}
            label="Running"
          />
        </Grid>
        <Grid item xs={6} sm={4} md={3} lg>
          <Stat
            icon={<StopIcon fontSize="inherit" />}
            color="#9e9e9e"
            value={stats.stopped}
            label="Stopped"
          />
        </Grid>
        <Grid item xs={6} sm={4} md={3} lg>
          <Stat
            icon={<ErrorOutlineIcon fontSize="inherit" />}
            color="#e53935"
            value={stats.errored}
            label="Error / provisioning"
          />
        </Grid>
        <Grid item xs={6} sm={4} md={3} lg>
          <Stat
            icon={<DnsIcon fontSize="inherit" />}
            color="#3949ab"
            value={stats.nodes.length}
            label="Nodes in use"
          />
        </Grid>
      </Grid>

      <Grid container spacing={3} className={classes.section}>
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Instances by node
              </Typography>
              {stats.nodes.length === 0 ? (
                <Typography variant="body2" color="textSecondary">
                  No instances yet.
                </Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Node</TableCell>
                      <TableCell align="right">Instances</TableCell>
                      <TableCell align="right">Running</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {stats.nodes.map(([node, c]) => (
                      <TableRow key={node} hover>
                        <TableCell>{node}</TableCell>
                        <TableCell align="right">{c.total}</TableCell>
                        <TableCell align="right">{c.running}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={5}>
          <Card style={{ marginBottom: 24 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Versions
              </Typography>
              {stats.versions.length === 0 ? (
                <Typography variant="body2" color="textSecondary">
                  No versions reported.
                </Typography>
              ) : (
                <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
                  {stats.versions.map(([v, count]) => (
                    <Chip key={v} label={`${v} · ${count}`} />
                  ))}
                </Box>
              )}
            </CardContent>
          </Card>

          <Card className={classes.linkCard}>
            <Typography variant="h6" gutterBottom>
              Related tools
            </Typography>
            <Box display="flex" flexDirection="column" style={{ gap: 8 }}>
              <Button
                component={RouterLink}
                to="/proxmox"
                variant="outlined"
                startIcon={<OpenInNewIcon />}
              >
                Proxmox cluster monitoring
              </Button>
              <Button
                component={RouterLink}
                to="/dhis2/settings"
                variant="outlined"
                startIcon={<SettingsIcon />}
              >
                DHIS2 settings (Proxmox connection)
              </Button>
            </Box>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
