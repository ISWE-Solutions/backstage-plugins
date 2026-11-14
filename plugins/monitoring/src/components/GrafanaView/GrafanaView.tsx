import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Grid,
  InputAdornment,
  LinearProgress,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import DashboardIcon from '@material-ui/icons/Dashboard';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import SearchIcon from '@material-ui/icons/Search';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { GrafanaDashboard } from '../../types';
import {
  byFolder,
  grafanaUrl,
  loadGrafanaDashboards,
} from '../../services/grafana';

const useStyles = makeStyles(theme => ({
  card: { height: '100%' },
  area: { height: '100%', alignItems: 'flex-start' },
  title: { display: 'flex', alignItems: 'center', gap: theme.spacing(1) },
  icon: { color: theme.palette.primary.main },
  tag: { marginRight: theme.spacing(0.5), marginTop: theme.spacing(0.5) },
}));

const matches = (d: GrafanaDashboard, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [d.title, d.folderTitle ?? '', ...d.tags].some(s =>
    s.toLowerCase().includes(t),
  );
};

/** ISWE's Grafana dashboards, live from Grafana's search API, by folder. */
export const GrafanaView = () => {
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const root = grafanaUrl(configApi);
  const order = useMemo(
    () =>
      configApi.getOptionalStringArray('monitoring.grafanaFolderOrder') ?? [],
    [configApi],
  );
  const [dashboards, setDashboards] = useState<GrafanaDashboard[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadGrafanaDashboards({ discoveryApi, fetchApi, configApi })
      .then(d => !cancelled && setDashboards(d))
      .catch(e => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi, configApi]);

  if (error) {
    return (
      <Box p={3}>
        <Alert severity="error">
          Couldn't list the Grafana dashboards: {error}.{' '}
          {root && (
            <>
              Open Grafana directly: <a href={root}>{root}</a>
            </>
          )}
        </Alert>
      </Box>
    );
  }
  if (!dashboards) return <LinearProgress />;

  const groups = byFolder(
    dashboards.filter(d => matches(d, query)),
    order,
  );

  return (
    <Box p={3}>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        mb={3}
        style={{ gap: 16 }}
      >
        <Typography variant="h4" style={{ flexGrow: 1 }}>
          Grafana dashboards
        </Typography>
        <TextField
          variant="outlined"
          size="small"
          placeholder="Search title, folder or tag"
          value={query}
          onChange={e => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
        {root && (
          <Button
            variant="outlined"
            color="primary"
            endIcon={<OpenInNewIcon />}
            href={root}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Grafana
          </Button>
        )}
      </Box>

      <Typography variant="body2" color="textSecondary" paragraph>
        {dashboards.length} dashboards in {byFolder(dashboards).length} folders,
        listed live from Grafana. Each opens in Grafana, where you sign in with
        your ISWE account.
      </Typography>

      {groups.length === 0 && (
        <Alert severity="info">No dashboard matches “{query}”.</Alert>
      )}

      {groups.map(g => (
        <Box key={g.folder} mb={4}>
          <Typography variant="h5" gutterBottom>
            {g.folder}{' '}
            <Typography component="span" color="textSecondary">
              ({g.dashboards.length})
            </Typography>
          </Typography>
          <Grid container spacing={2}>
            {g.dashboards.map(d => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={d.uid}>
                <Card className={classes.card} variant="outlined">
                  <CardActionArea
                    className={classes.area}
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <CardContent>
                      <Box className={classes.title}>
                        <DashboardIcon className={classes.icon} />
                        <Typography variant="subtitle1">{d.title}</Typography>
                        <OpenInNewIcon fontSize="small" color="disabled" />
                      </Box>
                      <Box mt={1}>
                        {d.tags.map(tag => (
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
                  </CardActionArea>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      ))}
    </Box>
  );
};
