import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Button,
  Chip,
  LinearProgress,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { GrafanaDashboard } from '../../types';
import { monitoringService } from '../../services/monitoringService';
import DashboardIcon from '@material-ui/icons/Dashboard';
import StarIcon from '@material-ui/icons/Star';
import StarBorderIcon from '@material-ui/icons/StarBorder';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  cardContent: {
    flexGrow: 1,
  },
  tag: {
    margin: theme.spacing(0.5),
  },
  dashboardIcon: {
    fontSize: 48,
    color: theme.palette.primary.main,
    marginBottom: theme.spacing(2),
  },
  starButton: {
    minWidth: 'auto',
    padding: theme.spacing(1),
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing(1),
  },
}));

export const GrafanaView = () => {
  const classes = useStyles();
  const [dashboards, setDashboards] = useState<GrafanaDashboard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await monitoringService.getGrafanaDashboards();
        setDashboards(data);
      } catch (error) {
        console.error('Failed to fetch Grafana dashboards:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return <LinearProgress />;
  }

  const starredDashboards = dashboards.filter(d => d.starred);
  const regularDashboards = dashboards.filter(d => !d.starred);

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        Grafana Dashboards
      </Typography>

      <Alert severity="info" style={{ marginBottom: 24 }}>
        Connect to your Grafana instance at{' '}
        <strong>https://grafana.example.org</strong> to view detailed analytics and
        metrics
      </Alert>

      {starredDashboards.length > 0 && (
        <>
          <Typography variant="h5" gutterBottom style={{ marginTop: 24 }}>
            Starred Dashboards
          </Typography>
          <Grid container spacing={3} style={{ marginBottom: 32 }}>
            {starredDashboards.map(dashboard => (
              <Grid item xs={12} sm={6} md={4} key={dashboard.id}>
                <Card className={classes.card}>
                  <CardContent className={classes.cardContent}>
                    <Box className={classes.header}>
                      <DashboardIcon className={classes.dashboardIcon} />
                      <Button
                        className={classes.starButton}
                        startIcon={<StarIcon style={{ color: '#ffc107' }} />}
                      />
                    </Box>

                    <Typography variant="h6" gutterBottom>
                      {dashboard.title}
                    </Typography>

                    {dashboard.folderTitle && (
                      <Typography
                        variant="caption"
                        color="textSecondary"
                        display="block"
                        gutterBottom
                      >
                        Folder: {dashboard.folderTitle}
                      </Typography>
                    )}

                    <Box mt={2}>
                      {dashboard.tags.map(tag => (
                        <Chip
                          key={tag}
                          label={tag}
                          size="small"
                          variant="outlined"
                          className={classes.tag}
                        />
                      ))}
                    </Box>
                  </CardContent>

                  <Box p={2} pt={0}>
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      endIcon={<OpenInNewIcon />}
                      href={dashboard.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open Dashboard
                    </Button>
                  </Box>
                </Card>
              </Grid>
            ))}
          </Grid>
        </>
      )}

      <Typography variant="h5" gutterBottom>
        All Dashboards
      </Typography>
      <Grid container spacing={3}>
        {regularDashboards.map(dashboard => (
          <Grid item xs={12} sm={6} md={4} key={dashboard.id}>
            <Card className={classes.card}>
              <CardContent className={classes.cardContent}>
                <Box className={classes.header}>
                  <DashboardIcon className={classes.dashboardIcon} />
                  <Button
                    className={classes.starButton}
                    startIcon={<StarBorderIcon />}
                  />
                </Box>

                <Typography variant="h6" gutterBottom>
                  {dashboard.title}
                </Typography>

                {dashboard.folderTitle && (
                  <Typography
                    variant="caption"
                    color="textSecondary"
                    display="block"
                    gutterBottom
                  >
                    Folder: {dashboard.folderTitle}
                  </Typography>
                )}

                <Box mt={2}>
                  {dashboard.tags.map(tag => (
                    <Chip
                      key={tag}
                      label={tag}
                      size="small"
                      variant="outlined"
                      className={classes.tag}
                    />
                  ))}
                </Box>
              </CardContent>

              <Box p={2} pt={0}>
                <Button
                  variant="outlined"
                  color="primary"
                  fullWidth
                  endIcon={<OpenInNewIcon />}
                  href={dashboard.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Dashboard
                </Button>
              </Box>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};
