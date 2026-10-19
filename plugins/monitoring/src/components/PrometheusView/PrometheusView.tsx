import { useCallback, useEffect, useState } from 'react';
import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  LinearProgress,
  Chip,
  Link,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { catalogApiRef, EntityRefLink } from '@backstage/plugin-catalog-react';
import { ServiceHealth } from '../../types';
import {
  GUESTS_ANNOTATION,
  HEALTH_URL_ANNOTATION,
  loadLiveServiceHealth,
} from '../../services/liveHealth';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import WarningIcon from '@material-ui/icons/Warning';
import ErrorIcon from '@material-ui/icons/Error';
import HelpIcon from '@material-ui/icons/Help';

const REFRESH_MS = 60_000;

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
    marginBottom: theme.spacing(1),
  },
}));

const STATUS = {
  down: { color: '#f44336', Icon: ErrorIcon, label: 'Down Services' },
  degraded: { color: '#ff9800', Icon: WarningIcon, label: 'Degraded Services' },
  unknown: { color: '#9e9e9e', Icon: HelpIcon, label: 'No Data' },
  healthy: {
    color: '#4caf50',
    Icon: CheckCircleIcon,
    label: 'Healthy Services',
  },
} as const;

const getStatusColor = (status: ServiceHealth['status']) => {
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

const getMetricColor = (value: number, threshold: number = 80) => {
  if (value >= threshold) return 'error';
  if (value >= threshold * 0.75) return 'secondary';
  return 'primary';
};

const fmt = (v: number | undefined, digits: number, unit: string) =>
  v === undefined ? '—' : `${v.toFixed(digits)}${unit}`;

const UsageBar = ({ label, value }: { label: string; value?: number }) => {
  const classes = useStyles();
  return (
    <Box mt={1}>
      <Box className={classes.metricRow}>
        <Typography variant="caption">{label}</Typography>
        <Typography variant="caption">{fmt(value, 1, '%')}</Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={Math.min(value ?? 0, 100)}
        color={getMetricColor(value ?? 0) as any}
        className={classes.progressBar}
      />
    </Box>
  );
};

/**
 * Live health of the catalog Components annotated with
 * `iswesolutions.com/health-url` (and optionally `iswesolutions.com/proxmox-guests`),
 * from the Prometheus site checks, certificate checks and Proxmox guest metrics.
 */
export const PrometheusView = () => {
  const classes = useStyles();
  const catalogApi = useApi(catalogApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchData = useCallback(async () => {
    try {
      setServices(
        await loadLiveServiceHealth({
          catalogApi,
          discoveryApi,
          fetchApi,
          configApi,
        }),
      );
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [catalogApi, discoveryApi, fetchApi, configApi]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return <LinearProgress />;
  }

  const count = (s: ServiceHealth['status']) =>
    services.filter(x => x.status === s).length;
  const degradedCount = count('degraded');
  const downCount = count('down');

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        System Health Monitoring
      </Typography>
      <Typography variant="body2" color="textSecondary" paragraph>
        Live from Prometheus for the catalog components with the{' '}
        <code>{HEALTH_URL_ANNOTATION}</code> annotation; refreshes every minute.
      </Typography>

      {error && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          <strong>Could not load live health:</strong> {error}
        </Alert>
      )}

      <Grid container spacing={3} style={{ marginBottom: 24 }}>
        {(Object.keys(STATUS) as ServiceHealth['status'][]).map(s => {
          const { color, Icon, label } = STATUS[s];
          return (
            <Grid item xs={12} sm={6} md={3} key={s}>
              <Card>
                <CardContent>
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Box>
                      <Typography variant="h3" style={{ color }}>
                        {count(s)}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        {label}
                      </Typography>
                    </Box>
                    <Icon style={{ fontSize: 48, color }} />
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      {degradedCount > 0 && (
        <Alert severity="warning" style={{ marginBottom: 16 }}>
          <strong>Warning:</strong> {degradedCount} service(s) degraded
        </Alert>
      )}

      {downCount > 0 && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          <strong>Critical:</strong> {downCount} service(s) are currently down
        </Alert>
      )}

      {!error && services.length === 0 && (
        <Alert severity="info" style={{ marginBottom: 16 }}>
          No catalog components to show. Add the{' '}
          <code>{HEALTH_URL_ANNOTATION}</code> annotation (the URL the site
          checks probe) and, for CPU and memory,{' '}
          <code>{GUESTS_ANNOTATION}</code> (comma-separated Proxmox guest names)
          to a Component.
        </Alert>
      )}

      <Grid container spacing={3}>
        {services.map(service => {
          const { color, Icon } = STATUS[service.status];
          return (
            <Grid item xs={12} md={6} key={service.entityRef}>
              <Card className={classes.card}>
                <CardContent>
                  <Box className={classes.serviceHeader}>
                    <Icon style={{ color }} />
                    <Typography variant="h6" style={{ marginLeft: 8, flex: 1 }}>
                      <EntityRefLink
                        entityRef={service.entityRef}
                        title={service.serviceName}
                      />
                    </Typography>
                    <Chip
                      label={service.status.toUpperCase()}
                      size="small"
                      color={getStatusColor(service.status) as any}
                      className={classes.statusChip}
                    />
                  </Box>
                  <Typography variant="caption" color="textSecondary">
                    <Link href={service.url} target="_blank" rel="noopener">
                      {service.url}
                    </Link>
                    {service.system && ` · system ${service.system}`}
                  </Typography>
                  {service.reasons.length > 0 && (
                    <Box mt={1}>
                      {service.reasons.map(r => (
                        <Typography variant="body2" key={r} style={{ color }}>
                          {r}
                        </Typography>
                      ))}
                    </Box>
                  )}

                  <Box className={classes.metricRow}>
                    <Typography variant="body2">Uptime (24 h)</Typography>
                    <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                      {fmt(service.uptime24h, 2, '%')}
                    </Typography>
                  </Box>

                  <Box className={classes.metricRow}>
                    <Typography variant="body2">Response Time</Typography>
                    <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                      {fmt(service.responseTimeMs, 0, ' ms')}
                    </Typography>
                  </Box>

                  <Box className={classes.metricRow}>
                    <Typography variant="body2">Certificate</Typography>
                    <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                      {service.certDaysLeft === undefined
                        ? '—'
                        : `${Math.floor(service.certDaysLeft)} days left`}
                    </Typography>
                  </Box>

                  {service.guests.length > 0 ? (
                    <>
                      <UsageBar label="CPU Usage" value={service.cpuPercent} />
                      <UsageBar
                        label="Memory Usage"
                        value={service.memoryPercent}
                      />
                    </>
                  ) : (
                    <Typography variant="caption" color="textSecondary">
                      No Proxmox guests annotated, so no CPU or memory.
                    </Typography>
                  )}

                  <Box mt={2} display="flex" justifyContent="space-between">
                    <Typography variant="caption" color="textSecondary">
                      {service.guests.length > 1
                        ? `Busiest of: ${service.guests.join(', ')}`
                        : service.guests.join('')}
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      Last check:{' '}
                      {new Date(service.lastCheck).toLocaleTimeString()}
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
};
