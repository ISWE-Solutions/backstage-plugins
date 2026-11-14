import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Grid,
  LinearProgress,
  Link,
  Switch,
  Typography,
} from '@material-ui/core';
import { Alert, ToggleButton, ToggleButtonGroup } from '@material-ui/lab';
import RefreshIcon from '@material-ui/icons/Refresh';
import { Table, TableColumn } from '@backstage/core-components';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SecurityAlert } from '../../types';
import {
  loadSecurityAlerts,
  SecurityAlerts,
  SEVERITY_ORDER,
} from '../../services/githubSecurity';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#b71c1c',
  high: '#e65100',
  medium: '#f9a825',
  low: '#78909c',
};
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
type SourceFilter = 'all' | 'dependabot' | 'code-scanning';
type Counts = { critical: number; high: number; medium: number; low: number };

const days = (iso: string) =>
  Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));

const SeverityChip = ({ severity }: { severity: string }) => (
  <Chip
    size="small"
    label={severity}
    style={{
      backgroundColor: SEVERITY_COLORS[severity],
      color: '#fff',
      fontWeight: 600,
    }}
  />
);

const Stat = ({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) => (
  <Card
    style={{
      height: '100%',
      borderLeft: color ? `4px solid ${color}` : undefined,
    }}
  >
    <CardContent>
      <Typography variant="overline" color="textSecondary">
        {label}
      </Typography>
      <Typography variant="h4">{value}</Typography>
    </CardContent>
  </Card>
);

/** Open Dependabot and code-scanning alerts of the GitHub organization, live. */
export const SecurityView = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [data, setData] = useState<SecurityAlerts>();
  const [loaded, setLoaded] = useState(0);
  const [loading, setLoading] = useState(true);
  const [includeForks, setIncludeForks] = useState(false);
  const [source, setSource] = useState<SourceFilter>('all');
  const [severity, setSeverity] = useState<string[]>([]);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      setLoaded(0);
      loadSecurityAlerts(
        { discoveryApi, fetchApi, configApi },
        { refresh, onProgress: setLoaded },
      )
        .then(setData)
        .finally(() => setLoading(false));
    },
    [discoveryApi, fetchApi, configApi],
  );
  useEffect(() => load(false), [load]);

  const visible = useMemo(
    () =>
      (data?.alerts ?? []).filter(
        a =>
          (includeForks || !a.fork) &&
          (source === 'all' || a.source === source) &&
          (severity.length === 0 || severity.includes(a.severity)),
      ),
    [data, includeForks, source, severity],
  );

  if (loading && !data) {
    return (
      <Box p={3}>
        <Typography gutterBottom>
          Loading open security alerts from GitHub…{' '}
          {loaded > 0 && `${loaded} so far`}
        </Typography>
        <LinearProgress />
      </Box>
    );
  }
  if (!data) return null;

  const forkAlerts = data.alerts.filter(a => a.fork).length;
  const bySeverity = (sev: string) =>
    visible.filter(a => a.severity === sev).length;
  const repos = new Map<string, Counts>();
  for (const a of visible) {
    const r = repos.get(a.repository) ?? {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    r[a.severity] += 1;
    repos.set(a.repository, r);
  }
  const repoChart = [...repos.entries()]
    .map(([name, c]) => ({
      name,
      ...c,
      total: c.critical + c.high + c.medium + c.low,
    }))
    .sort(
      (a, b) => b.critical - a.critical || b.high - a.high || b.total - a.total,
    )
    .slice(0, 15);
  const ecosystems = new Map<string, number>();
  for (const a of visible) {
    const k = a.ecosystem ?? 'other';
    ecosystems.set(k, (ecosystems.get(k) ?? 0) + 1);
  }
  const oldestCritical = visible
    .filter(a => a.severity === 'critical')
    .reduce((m, a) => Math.max(m, days(a.createdAt)), 0);
  const notAllowed = data.errors.filter(
    e => e.status === 401 || e.status === 403 || e.status === 404,
  );

  const columns: TableColumn<SecurityAlert>[] = [
    {
      title: 'Severity',
      field: 'severity',
      width: '90px',
      customSort: (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      defaultSort: 'asc',
      render: a => <SeverityChip severity={a.severity} />,
    },
    {
      title: 'Alert',
      field: 'title',
      highlight: true,
      render: a => (
        <>
          {a.url ? (
            <Link href={a.url} target="_blank" rel="noopener noreferrer">
              {a.title}
            </Link>
          ) : (
            a.title
          )}
          <Typography variant="caption" color="textSecondary" component="div">
            {a.source === 'dependabot' ? 'Dependabot' : 'Code scanning'}
            {a.cve && ` · ${a.cve}`}
          </Typography>
        </>
      ),
    },
    {
      title: 'Package or rule',
      field: 'packageName',
      render: a => (
        <>
          {a.packageName}
          <Typography variant="caption" color="textSecondary" component="div">
            {a.ecosystem}
          </Typography>
        </>
      ),
    },
    {
      title: 'Vulnerable / fixed in',
      field: 'fixedVersion',
      render: a =>
        a.source === 'dependabot'
          ? `${a.currentVersion || '?'} → ${a.fixedVersion ?? 'no fix yet'}`
          : '',
    },
    {
      title: 'Repository',
      field: 'repository',
      render: a => (
        <>
          {a.repositoryUrl ? (
            <Link
              href={a.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {a.repository}
            </Link>
          ) : (
            a.repository
          )}
          {a.fork && (
            <Typography variant="caption" color="textSecondary" component="div">
              fork
            </Typography>
          )}
        </>
      ),
    },
    { title: 'File', field: 'location' },
    {
      title: 'Open for',
      field: 'createdAt',
      type: 'numeric',
      customSort: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      render: a => `${days(a.createdAt)} days`,
    },
  ];

  return (
    <Box p={3}>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        mb={2}
        style={{ gap: 16 }}
      >
        <Typography variant="h4" style={{ flexGrow: 1 }}>
          Security alerts (GitHub)
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={source}
          onChange={(_e, v) => v && setSource(v)}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="dependabot">Dependabot</ToggleButton>
          <ToggleButton value="code-scanning">Code scanning</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel
          control={
            <Switch
              checked={includeForks}
              onChange={e => setIncludeForks(e.target.checked)}
              color="primary"
            />
          }
          label={`Include forks (${forkAlerts} alerts)`}
        />
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          disabled={loading}
          onClick={() => load(true)}
        >
          Refresh
        </Button>
      </Box>
      {loading && <LinearProgress style={{ marginBottom: 16 }} />}

      {notAllowed.length > 0 && (
        <Alert severity="warning" style={{ marginBottom: 16 }}>
          GitHub refused {notAllowed.map(e => e.source).join(' and ')} alerts (
          {notAllowed.map(e => e.message).join('; ')}). Backstage's GitHub token
          needs to read security alerts: the <code>security_events</code> scope
          on a classic token of an organization owner, or "Dependabot alerts"
          and "Code scanning alerts" (read) on a fine-grained one. Code scanning
          also has to be set up in at least one repository.
        </Alert>
      )}
      {data.errors
        .filter(e => !notAllowed.includes(e))
        .map(e => (
          <Alert key={e.source} severity="error" style={{ marginBottom: 16 }}>
            {e.message}
          </Alert>
        ))}

      <Typography variant="body2" color="textSecondary" paragraph>
        Open alerts in the organization's repositories, loaded{' '}
        {new Date(data.loadedAt).toLocaleTimeString()} (kept for 15 minutes).
        {!includeForks &&
          ' Forks of upstream projects are left out; their alerts are mostly fixed upstream.'}{' '}
        Secret-scanning alerts aren't shown here: open them on GitHub.
      </Typography>

      <Grid container spacing={2} style={{ marginBottom: 16 }}>
        {SEVERITIES.map(s => (
          <Grid item xs={6} sm={4} md={2} key={s}>
            <Box
              style={{
                cursor: 'pointer',
                opacity:
                  severity.length === 0 || severity.includes(s) ? 1 : 0.4,
              }}
              onClick={() =>
                setSeverity(cur =>
                  cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s],
                )
              }
            >
              <Stat
                label={s}
                value={bySeverity(s)}
                color={SEVERITY_COLORS[s]}
              />
            </Box>
          </Grid>
        ))}
        <Grid item xs={6} sm={4} md={2}>
          <Stat label="Repositories" value={repos.size} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Stat
            label="Oldest critical"
            value={oldestCritical ? `${oldestCritical} d` : '–'}
          />
        </Grid>
      </Grid>

      {repoChart.length > 0 && (
        <Grid container spacing={3} style={{ marginBottom: 16 }}>
          <Grid item xs={12} md={8}>
            <Card>
              <CardContent>
                <Typography variant="h6">By repository (top 15)</Typography>
                <ResponsiveContainer
                  width="100%"
                  height={Math.max(200, repoChart.length * 26)}
                >
                  <BarChart
                    data={repoChart}
                    layout="vertical"
                    margin={{ left: 24 }}
                  >
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={170} />
                    <Tooltip />
                    {SEVERITIES.map(s => (
                      <Bar
                        key={s}
                        dataKey={s}
                        stackId="a"
                        fill={SEVERITY_COLORS[s]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={4}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  By ecosystem or tool
                </Typography>
                {[...ecosystems.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <Box
                      key={k}
                      display="flex"
                      justifyContent="space-between"
                      py={0.5}
                    >
                      <Typography>{k}</Typography>
                      <Typography color="textSecondary">{n}</Typography>
                    </Box>
                  ))}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      <Table<SecurityAlert>
        title={`${visible.length} open alerts`}
        options={{
          paging: true,
          pageSize: 25,
          pageSizeOptions: [25, 50, 100],
          search: true,
          padding: 'dense',
        }}
        columns={columns}
        data={visible}
      />
    </Box>
  );
};
