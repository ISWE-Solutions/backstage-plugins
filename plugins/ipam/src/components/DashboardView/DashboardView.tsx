import { useEffect, useState } from 'react';
import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  LinearProgress,
  Chip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { IPAMStatistics, Subnet } from '../../types';
import { useApi } from '@backstage/core-plugin-api';
import { ipamApiRef, SyncRun, UsagePoint } from '../../services/ipamService';
import { UsageTrend } from './UsageTrend';
import { SyncStatusCard } from './SyncStatusCard';
import RouterIcon from '@material-ui/icons/Router';
import DnsIcon from '@material-ui/icons/Dns';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
  },
  statValue: {
    fontSize: '2rem',
    fontWeight: 'bold',
    color: theme.palette.primary.main,
  },
  statLabel: {
    color: theme.palette.text.secondary,
    marginTop: theme.spacing(1),
  },
  iconBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 60,
    height: 60,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.primary.light,
    color: theme.palette.primary.contrastText,
  },
  utilizationBar: {
    height: 10,
    borderRadius: 5,
    marginTop: theme.spacing(1),
  },
  subnetCard: {
    marginBottom: theme.spacing(2),
  },
  vlanChip: {
    margin: theme.spacing(0.5),
  },
}));

export const DashboardView = () => {
  const ipamService = useApi(ipamApiRef);
  const classes = useStyles();
  const [statistics, setStatistics] = useState<IPAMStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [history, setHistory] = useState<UsagePoint[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>();

  useEffect(() => {
    ipamService
      .getUsageHistory(90)
      .then(setHistory)
      .catch(() => setHistory([]));
    ipamService
      .getSyncStatus(5)
      .then(setSyncRuns)
      .catch(() => setSyncRuns([]));
  }, [ipamService]);

  useEffect(() => {
    const fetchStatistics = async () => {
      try {
        const stats = await ipamService.getStatistics();
        setStatistics(stats);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    };

    fetchStatistics();
  }, [ipamService]);

  if (loading) {
    return <LinearProgress />;
  }

  if (!statistics) {
    return (
      <Alert severity="error">
        Failed to load IPAM data from phpIPAM
        {loadError ? `: ${loadError}` : '.'}
      </Alert>
    );
  }

  const getUtilizationColor = (percent: number) => {
    if (percent >= 90) return 'error';
    if (percent >= 75) return 'warning';
    return 'success';
  };

  return (
    <Box p={3}>
      <Grid container spacing={3}>
        {/* Total Subnets */}
        <Grid item xs={12} sm={6} md={3}>
          <Card className={classes.card}>
            <CardContent>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
              >
                <Box>
                  <Typography className={classes.statValue}>
                    {statistics.totalSubnets}
                  </Typography>
                  <Typography className={classes.statLabel}>
                    Total Subnets
                  </Typography>
                </Box>
                <Box className={classes.iconBox}>
                  <RouterIcon fontSize="large" />
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Total IPs */}
        <Grid item xs={12} sm={6} md={3}>
          <Card className={classes.card}>
            <CardContent>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
              >
                <Box>
                  <Typography className={classes.statValue}>
                    {statistics.totalIPs.toLocaleString()}
                  </Typography>
                  <Typography className={classes.statLabel}>
                    Total IP Addresses
                  </Typography>
                </Box>
                <Box className={classes.iconBox}>
                  <DnsIcon fontSize="large" />
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Allocated IPs */}
        <Grid item xs={12} sm={6} md={3}>
          <Card className={classes.card}>
            <CardContent>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
              >
                <Box>
                  <Typography className={classes.statValue}>
                    {statistics.allocatedIPs}
                  </Typography>
                  <Typography className={classes.statLabel}>
                    Allocated IPs
                  </Typography>
                </Box>
                <Box className={classes.iconBox}>
                  <CheckCircleIcon fontSize="large" />
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Available IPs */}
        <Grid item xs={12} sm={6} md={3}>
          <Card className={classes.card}>
            <CardContent>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
              >
                <Box>
                  <Typography className={classes.statValue}>
                    {statistics.availableIPs.toLocaleString()}
                  </Typography>
                  <Typography className={classes.statLabel}>
                    Available IPs
                  </Typography>
                </Box>
                <Box className={classes.iconBox}>
                  <ErrorIcon fontSize="large" />
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Overall Utilization */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Overall IP Utilization
              </Typography>
              <Box mt={2}>
                <Box display="flex" justifyContent="space-between" mb={1}>
                  <Typography variant="body2">
                    {statistics.allocatedIPs} / {statistics.totalIPs} IPs
                    allocated
                  </Typography>
                  <Typography variant="body2" color="primary">
                    {statistics.utilizationPercent.toFixed(1)}%
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={statistics.utilizationPercent}
                  color={
                    getUtilizationColor(statistics.utilizationPercent) as any
                  }
                  className={classes.utilizationBar}
                />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Subnets by VLAN */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Subnets by VLAN
              </Typography>
              <Box mt={2}>
                {Object.entries(statistics.subnetsByVLAN).map(
                  ([vlan, count]) => (
                    <Chip
                      key={vlan}
                      label={`${vlan}: ${count}`}
                      className={classes.vlanChip}
                      color="primary"
                      variant="outlined"
                    />
                  ),
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Subnet usage over time
              </Typography>
              <UsageTrend points={history} />
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Discovery sync
              </Typography>
              <SyncStatusCard runs={syncRuns} />
            </CardContent>
          </Card>
        </Grid>

        {/* Top Utilized Subnets */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Top Utilized Subnets
              </Typography>
              {statistics.topUtilizedSubnets.length === 0 ? (
                <Typography variant="body2" color="textSecondary">
                  No subnet data available
                </Typography>
              ) : (
                statistics.topUtilizedSubnets.map((subnet: Subnet) => (
                  <Box key={subnet.id} className={classes.subnetCard}>
                    <Box display="flex" justifyContent="space-between" mb={1}>
                      <Typography variant="body1">
                        {subnet.network}/{subnet.cidr} - {subnet.description}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        {subnet.usedIPs} / {subnet.totalIPs} IPs
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={subnet.utilizationPercent}
                      color={
                        getUtilizationColor(subnet.utilizationPercent) as any
                      }
                      className={classes.utilizationBar}
                    />
                    <Typography variant="caption" color="textSecondary">
                      {subnet.utilizationPercent.toFixed(1)}% utilized
                    </Typography>
                  </Box>
                ))
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Alerts */}
        {statistics.topUtilizedSubnets.some(
          s => s.utilizationPercent >= 90,
        ) && (
          <Grid item xs={12}>
            <Alert severity="error">
              <Typography variant="body2">
                <strong>Critical:</strong> Some subnets are at 90% or higher
                utilization. Consider expanding capacity or reclaiming unused
                IPs.
              </Typography>
            </Alert>
          </Grid>
        )}

        {statistics.topUtilizedSubnets.some(
          s => s.utilizationPercent >= 75 && s.utilizationPercent < 90,
        ) && (
          <Grid item xs={12}>
            <Alert severity="warning">
              <Typography variant="body2">
                <strong>Warning:</strong> Some subnets are approaching capacity
                (75%+). Monitor closely and plan for expansion.
              </Typography>
            </Alert>
          </Grid>
        )}
      </Grid>
    </Box>
  );
};
