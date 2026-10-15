import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Chip,
  LinearProgress,
  makeStyles,
} from '@material-ui/core';
import DnsIcon from '@material-ui/icons/Dns';
import { ProxmoxNode } from '../types';

const useStyles = makeStyles(theme => ({
  nodeCard: {
    marginBottom: theme.spacing(2),
  },
  sectionTitle: {
    marginBottom: theme.spacing(2),
  },
  progressBar: {
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(1),
  },
}));

export interface OdooProxmoxClusterPanelProps {
  nodes: ProxmoxNode[];
}

export const OdooProxmoxClusterPanel = (
  props: OdooProxmoxClusterPanelProps,
) => {
  const { nodes } = props;
  const classes = useStyles();

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  return (
    <Box>
      <Typography variant="h6" className={classes.sectionTitle}>
        Proxmox Cluster Nodes
      </Typography>

      <Grid container spacing={3}>
        {nodes.map(node => (
          <Grid item xs={12} md={4} key={node.node}>
            <Card className={classes.nodeCard}>
              <CardContent>
                <Box display="flex" alignItems="center" mb={2}>
                  <DnsIcon color="primary" style={{ marginRight: 8 }} />
                  <Typography variant="h6">{node.node}</Typography>
                  <Chip
                    label={node.status}
                    size="small"
                    color={node.status === 'online' ? 'primary' : 'secondary'}
                    style={{ marginLeft: 'auto' }}
                  />
                </Box>

                <Box mb={2}>
                  <Typography variant="body2">CPU Usage</Typography>
                  <LinearProgress
                    variant="determinate"
                    value={node.cpu * 100}
                    className={classes.progressBar}
                  />
                  <Typography variant="caption">
                    {(node.cpu * node.maxcpu).toFixed(1)} / {node.maxcpu} cores
                  </Typography>
                </Box>

                <Box mb={2}>
                  <Typography variant="body2">Memory</Typography>
                  <LinearProgress
                    variant="determinate"
                    value={(node.mem / node.maxmem) * 100}
                    className={classes.progressBar}
                  />
                  <Typography variant="caption">
                    {formatBytes(node.mem)} / {formatBytes(node.maxmem)}
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2">Storage</Typography>
                  <LinearProgress
                    variant="determinate"
                    value={(node.disk / node.maxdisk) * 100}
                    className={classes.progressBar}
                  />
                  <Typography variant="caption">
                    {formatBytes(node.disk)} / {formatBytes(node.maxdisk)}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};
