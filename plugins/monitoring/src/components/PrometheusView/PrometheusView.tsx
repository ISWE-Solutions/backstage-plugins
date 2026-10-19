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
import { ServiceHealth } from '../../types';
import { monitoringService } from '../../services/monitoringService';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import WarningIcon from '@material-ui/icons/Warning';
import ErrorIcon from '@material-ui/icons/Error';

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
  },
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  metricRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(1),
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
    marginTop: theme.spacing(0.5),
  },
  serviceHeader: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: theme.spacing(2),
  },
}));

const getStatusColor = (status: string) => {
  switch (status) {
    case 'healthy':
      return 'primary';
    case 'degraded':
      return 'secondary';
    case 'down':
      return 'error';
    default:
      return 'default';
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'healthy':
      return <CheckCircleIcon style={{ color: '#4caf50' }} />;
    case 'degraded':
      return <WarningIcon style={{ color: '#ff9800' }} />;
    case 'down':
      return <ErrorIcon style={{ color: '#f44336' }} />;
    default:
      return null;
  }
};

const getMetricColor = (value: number, threshold: number = 80) => {
  if (value >= threshold) return 'error';
  if (value >= threshold * 0.75) return 'secondary';
  return 'primary';
};

export const PrometheusView = () => {
  const classes = useStyles();
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await monitoringService.getServiceHealth();
        setServices(data);
      } catch (error) {
        console.error('Failed to fetch service health:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <LinearProgress />;
  }

  const healthyCount = services.filter(s => s.status === 'healthy').length;
  const degradedCount = services.filter(s => s.status === 'degraded').length;
  const downCount = services.filter(s => s.status === 'down').length;

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        System Health Monitoring
      </Typography>

      <Grid container spacing={3} style={{ marginBottom: 24 }}>
        <Grid item xs={12} sm={4}>
          <Card>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#4caf50' }}>
                    {healthyCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Healthy Services
                  </Typography>
                </Box>
                <CheckCircleIcon style={{ fontSize: 48, color: '#4caf50' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={4}>
          <Card>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#ff9800' }}>
                    {degradedCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Degraded Services
                  </Typography>
                </Box>
                <WarningIcon style={{ fontSize: 48, color: '#ff9800' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={4}>
          <Card>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#f44336' }}>
                    {downCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Down Services
                  </Typography>
                </Box>
                <ErrorIcon style={{ fontSize: 48, color: '#f44336' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {degradedCount > 0 && (
        <Alert severity="warning" style={{ marginBottom: 16 }}>
          <strong>Warning:</strong> {degradedCount} service(s) experiencing
          degraded performance
        </Alert>
      )}

      {downCount > 0 && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          <strong>Critical:</strong> {downCount} service(s) are currently down
        </Alert>
      )}

      <Grid container spacing={3}>
        {services.map(service => (
          <Grid item xs={12} md={6} key={service.serviceName}>
            <Card className={classes.card}>
              <CardContent>
                <Box className={classes.serviceHeader}>
                  {getStatusIcon(service.status)}
                  <Typography variant="h6" style={{ marginLeft: 8, flex: 1 }}>
                    {service.serviceName}
                  </Typography>
                  <Chip
                    label={service.status.toUpperCase()}
                    size="small"
                    color={getStatusColor(service.status) as any}
                    className={classes.statusChip}
                  />
                </Box>

                <Box className={classes.metricRow}>
                  <Typography variant="body2">Uptime</Typography>
                  <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                    {service.uptime}%
                  </Typography>
                </Box>

                <Box className={classes.metricRow}>
                  <Typography variant="body2">Response Time</Typography>
                  <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                    {service.responseTime}ms
                  </Typography>
                </Box>

                <Box className={classes.metricRow}>
                  <Typography variant="body2">Requests/sec</Typography>
                  <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                    {service.metrics.requestsPerSecond}
                  </Typography>
                </Box>

                <Box mt={2}>
                  <Box className={classes.metricRow}>
                    <Typography variant="caption">CPU Usage</Typography>
                    <Typography variant="caption">
                      {service.metrics.cpuUsage.toFixed(1)}%
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={service.metrics.cpuUsage}
                    color={getMetricColor(service.metrics.cpuUsage) as any}
                    className={classes.progressBar}
                  />
                </Box>

                <Box mt={1}>
                  <Box className={classes.metricRow}>
                    <Typography variant="caption">Memory Usage</Typography>
                    <Typography variant="caption">
                      {service.metrics.memoryUsage.toFixed(1)}%
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={service.metrics.memoryUsage}
                    color={getMetricColor(service.metrics.memoryUsage) as any}
                    className={classes.progressBar}
                  />
                </Box>

                <Box mt={1}>
                  <Box className={classes.metricRow}>
                    <Typography variant="caption">Disk Usage</Typography>
                    <Typography variant="caption">
                      {service.metrics.diskUsage.toFixed(1)}%
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={service.metrics.diskUsage}
                    color={getMetricColor(service.metrics.diskUsage) as any}
                    className={classes.progressBar}
                  />
                </Box>

                <Box mt={2} display="flex" justifyContent="space-between">
                  <Typography variant="caption" color="textSecondary">
                    Errors: {service.errorCount}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Last check:{' '}
                    {new Date(service.lastCheck).toLocaleTimeString()}
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
