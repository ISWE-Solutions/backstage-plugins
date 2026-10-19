import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Grid,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { SecurityAlert } from '../../types';
import { monitoringService } from '../../services/monitoringService';
import WarningIcon from '@material-ui/icons/Warning';
import ErrorIcon from '@material-ui/icons/Error';
import InfoIcon from '@material-ui/icons/Info';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';

const useStyles = makeStyles(theme => ({
  criticalCard: {
    borderLeft: `4px solid ${theme.palette.error.main}`,
  },
  highCard: {
    borderLeft: `4px solid #ff9800`,
  },
  mediumCard: {
    borderLeft: `4px solid #2196f3`,
  },
  lowCard: {
    borderLeft: `4px solid #4caf50`,
  },
  severityChip: {
    minWidth: 80,
  },
  alertIcon: {
    marginRight: theme.spacing(2),
  },
}));

const getSeverityColor = (severity: string) => {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'high':
      return 'secondary';
    case 'medium':
      return 'primary';
    case 'low':
      return 'default';
    default:
      return 'default';
  }
};

const getSeverityIcon = (severity: string) => {
  switch (severity) {
    case 'critical':
      return <ErrorIcon style={{ color: '#f44336' }} />;
    case 'high':
      return <WarningIcon style={{ color: '#ff9800' }} />;
    case 'medium':
      return <InfoIcon style={{ color: '#2196f3' }} />;
    case 'low':
      return <CheckCircleIcon style={{ color: '#4caf50' }} />;
    default:
      return null;
  }
};

export const SecurityView = () => {
  const classes = useStyles();
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await monitoringService.getSecurityAlerts();
        setAlerts(data);
      } catch (error) {
        console.error('Failed to fetch security alerts:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return <LinearProgress />;
  }

  const openAlerts = alerts.filter(a => a.status === 'open');
  const criticalCount = openAlerts.filter(
    a => a.severity === 'critical',
  ).length;
  const highCount = openAlerts.filter(a => a.severity === 'high').length;
  const mediumCount = openAlerts.filter(a => a.severity === 'medium').length;
  const lowCount = openAlerts.filter(a => a.severity === 'low').length;

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        Security Insights
      </Typography>

      <Grid container spacing={3} style={{ marginBottom: 24 }}>
        <Grid item xs={12} sm={3}>
          <Card style={{ borderLeft: '4px solid #f44336' }}>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#f44336' }}>
                    {criticalCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Critical
                  </Typography>
                </Box>
                <ErrorIcon style={{ fontSize: 40, color: '#f44336' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={3}>
          <Card style={{ borderLeft: '4px solid #ff9800' }}>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#ff9800' }}>
                    {highCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    High
                  </Typography>
                </Box>
                <WarningIcon style={{ fontSize: 40, color: '#ff9800' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={3}>
          <Card style={{ borderLeft: '4px solid #2196f3' }}>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#2196f3' }}>
                    {mediumCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Medium
                  </Typography>
                </Box>
                <InfoIcon style={{ fontSize: 40, color: '#2196f3' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={3}>
          <Card style={{ borderLeft: '4px solid #4caf50' }}>
            <CardContent>
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography variant="h3" style={{ color: '#4caf50' }}>
                    {lowCount}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Low
                  </Typography>
                </Box>
                <CheckCircleIcon style={{ fontSize: 40, color: '#4caf50' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {criticalCount > 0 && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          <strong>Critical Security Alert:</strong> {criticalCount} critical
          vulnerabilit{criticalCount === 1 ? 'y' : 'ies'} require immediate
          attention!
        </Alert>
      )}

      {highCount > 0 && (
        <Alert severity="warning" style={{ marginBottom: 16 }}>
          <strong>Warning:</strong> {highCount} high-severity vulnerabilit
          {highCount === 1 ? 'y' : 'ies'} detected
        </Alert>
      )}

      <Typography variant="h5" gutterBottom style={{ marginTop: 24 }}>
        Open Security Alerts
      </Typography>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Severity</TableCell>
              <TableCell>Title</TableCell>
              <TableCell>Package</TableCell>
              <TableCell>CVE</TableCell>
              <TableCell>Current Version</TableCell>
              <TableCell>Fixed Version</TableCell>
              <TableCell>Repository</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {openAlerts.map(alert => (
              <TableRow key={alert.id} hover>
                <TableCell>
                  <Box display="flex" alignItems="center">
                    {getSeverityIcon(alert.severity)}
                    <Chip
                      label={alert.severity.toUpperCase()}
                      size="small"
                      color={getSeverityColor(alert.severity) as any}
                      className={classes.severityChip}
                      style={{ marginLeft: 8 }}
                    />
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" style={{ fontWeight: 'bold' }}>
                    {alert.title}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    {alert.description}
                  </Typography>
                </TableCell>
                <TableCell>{alert.packageName}</TableCell>
                <TableCell>
                  {alert.cve ? (
                    <Typography
                      variant="body2"
                      style={{ fontFamily: 'monospace' }}
                    >
                      {alert.cve}
                    </Typography>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell style={{ fontFamily: 'monospace' }}>
                  {alert.currentVersion}
                </TableCell>
                <TableCell style={{ fontFamily: 'monospace' }}>
                  {alert.fixedVersion || 'N/A'}
                </TableCell>
                <TableCell style={{ fontSize: '0.85rem' }}>
                  {alert.repository}
                </TableCell>
                <TableCell>
                  <Chip label={alert.status} size="small" variant="outlined" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {alerts.filter(a => a.status === 'dismissed').length > 0 && (
        <>
          <Typography variant="h5" gutterBottom style={{ marginTop: 32 }}>
            Dismissed Alerts
          </Typography>
          <Typography variant="body2" color="textSecondary" gutterBottom>
            {alerts.filter(a => a.status === 'dismissed').length} alert(s) have
            been dismissed
          </Typography>
        </>
      )}
    </Box>
  );
};
