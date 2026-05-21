import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  InputAdornment,
  LinearProgress,
  Tooltip,
  Typography,
  makeStyles,
} from '@material-ui/core';
import SaveIcon from '@material-ui/icons/Save';
import RefreshIcon from '@material-ui/icons/Refresh';
import SearchIcon from '@material-ui/icons/Search';
import {
  DHIS2Instance,
  DHIS2PluginSettings,
  ProxmoxNode,
  ClusterContainer,
} from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { fetchApiRef, useApi } from '@backstage/core-plugin-api';

const useStyles = makeStyles(theme => ({
  section: { marginBottom: theme.spacing(3) },
  sectionTitle: { marginBottom: theme.spacing(2) },
  field: { marginBottom: theme.spacing(2) },
  actions: {
    display: 'flex',
    gap: theme.spacing(2),
    marginTop: theme.spacing(1),
  },
  usageCell: {
    minWidth: 140,
  },
  usageBar: {
    marginTop: 4,
    height: 6,
    borderRadius: 3,
  },
}));

const bytesToGiB = (b: number) => b / 1024 ** 3;

interface Props {
  instances: DHIS2Instance[];
  onNodesChange?: (nodes: ProxmoxNode[]) => void;
}

export const ProxmoxClusterPanel = ({ instances, onNodesChange }: Props) => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const [settings, setSettings] = useState<DHIS2PluginSettings>(() =>
    settingsService.load(),
  );
  const [nodes, setNodes] = useState<ProxmoxNode[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [containers, setContainers] = useState<ClusterContainer[]>([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [containerSearch, setContainerSearch] = useState('');
  const [containerPage, setContainerPage] = useState(0);
  const [containerRowsPerPage, setContainerRowsPerPage] = useState(10);
  const [vms, setVms] = useState<ClusterContainer[]>([]);
  const [loadingVms, setLoadingVms] = useState(false);
  const [vmSearch, setVmSearch] = useState('');
  const [vmPage, setVmPage] = useState(0);
  const [vmRowsPerPage, setVmRowsPerPage] = useState(10);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    ok: boolean;
    message: string;
    url?: string;
    status?: number;
    statusText?: string;
    durationMs?: number;
    bodySample?: string;
    timestamp: string;
  } | null>(null);

  const proxmox = settings.proxmox;
  const updateProxmox = (patch: Partial<typeof proxmox>) =>
    setSettings(prev => ({ ...prev, proxmox: { ...prev.proxmox, ...patch } }));

  const loadNodes = useCallback(
    async (silent = false) => {
      setLoadingNodes(true);
      try {
        const result = await dhis2Service.fetchNodes(proxmox, backstageFetch);
        setNodes(result.nodes);
        onNodesChange?.(result.nodes);

        const ok = result.source === 'api';
        const message = ok
          ? `Loaded ${result.nodes.length} node(s) from Proxmox API`
          : `Using mock nodes — ${result.error ?? 'Proxmox API unreachable'}`;
        setLastResult({
          ok,
          message,
          url: result.url,
          status: result.status,
          statusText: result.statusText,
          durationMs: result.durationMs,
          bodySample: result.bodySample,
          timestamp: new Date().toISOString(),
        });
        if (!silent) setSnackbar(message);
      } finally {
        setLoadingNodes(false);
      }
    },
    [onNodesChange, proxmox, backstageFetch],
  );

  const loadContainers = useCallback(
    async (silent = false) => {
      setLoadingContainers(true);
      try {
        const result = await dhis2Service.fetchClusterContainers(
          proxmox,
          backstageFetch,
        );
        setContainers(result.containers);
        if (!silent) {
          setSnackbar(
            result.source === 'api'
              ? `Loaded ${result.containers.length} container(s) from Proxmox API`
              : `Using mock containers — ${
                  result.error ?? 'Proxmox API unreachable'
                }`,
          );
        }
      } finally {
        setLoadingContainers(false);
      }
    },
    [proxmox, backstageFetch],
  );

  const loadVms = useCallback(
    async (silent = false) => {
      setLoadingVms(true);
      try {
        const result = await dhis2Service.fetchClusterVMs(
          proxmox,
          backstageFetch,
        );
        setVms(result.vms);
        if (!silent) {
          setSnackbar(
            result.source === 'api'
              ? `Loaded ${result.vms.length} VM(s) from Proxmox API`
              : `Using mock VMs — ${result.error ?? 'Proxmox API unreachable'}`,
          );
        }
      } finally {
        setLoadingVms(false);
      }
    },
    [proxmox, backstageFetch],
  );

  useEffect(() => {
    loadNodes(true);
    loadContainers(true);
    loadVms(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    settingsService.save(settings);
    setSnackbar('Proxmox cluster settings saved');
    // Re-fetch nodes against the newly saved settings
    loadNodes();
  };

  const handleTestConnection = async () => {
    setLoadingNodes(true);
    setSnackbar('Testing Proxmox connection…');
    try {
      const result = await dhis2Service.fetchNodes(proxmox, backstageFetch);
      setNodes(result.nodes);
      onNodesChange?.(result.nodes);
      const ok = result.source === 'api';
      const message = ok
        ? `Connected — ${result.nodes.length} node(s) returned`
        : `Connection failed — ${result.error ?? 'unknown error'}`;
      setLastResult({
        ok,
        message,
        url: result.url,
        status: result.status,
        statusText: result.statusText,
        durationMs: result.durationMs,
        bodySample: result.bodySample,
        timestamp: new Date().toISOString(),
      });
      setSnackbar(message);
    } finally {
      setLoadingNodes(false);
    }
  };

  return (
    <Box>
      {/* Connection settings */}
      <Card className={classes.section} variant="outlined">
        <CardContent>
          <Typography variant="h6" className={classes.sectionTitle}>
            Proxmox Cluster Connection
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Connection details for the Proxmox VE API used to orchestrate LXC
            containers running DHIS2. Use an API token in production —
            password auth is shown for completeness but cannot be used directly
            from the browser.
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxmox.useBackstageProxy}
                    onChange={e =>
                      updateProxmox({ useBackstageProxy: e.target.checked })
                    }
                  />
                }
                label="Route through Backstage backend proxy (recommended)"
              />
              <Typography
                variant="caption"
                color="textSecondary"
                display="block"
              >
                When enabled, calls go to the Backstage proxy path below and
                the API token is injected server-side. When disabled, the
                browser calls the Proxmox API directly (requires CORS and
                network reachability).
              </Typography>
            </Grid>

            {proxmox.useBackstageProxy && (
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  label="Backstage Proxy Path"
                  value={proxmox.backstageProxyPath}
                  onChange={e =>
                    updateProxmox({ backstageProxyPath: e.target.value })
                  }
                  helperText="Configured in app-config.yaml proxy.endpoints, e.g. /api/proxy/proxmox"
                  className={classes.field}
                />
              </Grid>
            )}

            <Grid item xs={12} md={proxmox.useBackstageProxy ? 6 : 8}>
              <TextField
                fullWidth
                label="API URL"
                value={proxmox.apiUrl}
                onChange={e => updateProxmox({ apiUrl: e.target.value })}
                helperText={
                  proxmox.useBackstageProxy
                    ? 'Informational only — actual target is set in app-config.yaml'
                    : 'e.g. https://pve.example.org:8006'
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth className={classes.field}>
                <InputLabel>Authentication</InputLabel>
                <Select
                  value={proxmox.authMethod}
                  onChange={e =>
                    updateProxmox({
                      authMethod: e.target.value as 'token' | 'password',
                    })
                  }
                >
                  <MenuItem value="token">API Token (recommended)</MenuItem>
                  <MenuItem value="password">Username / Password</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            {proxmox.authMethod === 'token' ? (
              <>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Token ID"
                    value={proxmox.tokenId ?? ''}
                    onChange={e => updateProxmox({ tokenId: e.target.value })}
                    helperText="e.g. backstage@pve!orchestrator"
                    className={classes.field}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    type="password"
                    label="Token Secret"
                    value={proxmox.tokenSecret ?? ''}
                    onChange={e =>
                      updateProxmox({ tokenSecret: e.target.value })
                    }
                    className={classes.field}
                  />
                </Grid>
              </>
            ) : (
              <>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Username"
                    value={proxmox.username ?? ''}
                    onChange={e => updateProxmox({ username: e.target.value })}
                    helperText="e.g. root@pam"
                    className={classes.field}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    type="password"
                    label="Password"
                    value={proxmox.password ?? ''}
                    onChange={e => updateProxmox({ password: e.target.value })}
                    className={classes.field}
                  />
                </Grid>
              </>
            )}

            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxmox.verifyTls}
                    onChange={e =>
                      updateProxmox({ verifyTls: e.target.checked })
                    }
                  />
                }
                label="Verify TLS certificate"
              />
            </Grid>
          </Grid>

          <Divider style={{ margin: '16px 0' }} />

          <Typography variant="subtitle1" gutterBottom>
            Container defaults
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Default Node"
                value={proxmox.defaultNode}
                onChange={e => updateProxmox({ defaultNode: e.target.value })}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Root FS Storage"
                value={proxmox.rootfsStorage}
                onChange={e =>
                  updateProxmox({ rootfsStorage: e.target.value })
                }
                helperText="e.g. local-lvm"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Template Storage"
                value={proxmox.templateStorage}
                onChange={e =>
                  updateProxmox({ templateStorage: e.target.value })
                }
                helperText="e.g. local"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="OS Template"
                value={proxmox.osTemplate}
                onChange={e => updateProxmox({ osTemplate: e.target.value })}
                helperText="Full volid, e.g. local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Network Bridge"
                value={proxmox.networkBridge}
                onChange={e =>
                  updateProxmox({ networkBridge: e.target.value })
                }
                helperText="e.g. vmbr0"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Nameservers"
                value={proxmox.nameserver}
                onChange={e => updateProxmox({ nameserver: e.target.value })}
                helperText="space-separated DNS servers"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Search Domain"
                value={proxmox.searchDomain}
                onChange={e =>
                  updateProxmox({ searchDomain: e.target.value })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Starting VMID"
                value={proxmox.vmidStart}
                onChange={e =>
                  updateProxmox({
                    vmidStart: parseInt(e.target.value, 10) || 100,
                  })
                }
                inputProps={{ min: 100, max: 999999 }}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxmox.unprivileged}
                    onChange={e =>
                      updateProxmox({ unprivileged: e.target.checked })
                    }
                  />
                }
                label="Unprivileged containers"
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxmox.startOnBoot}
                    onChange={e =>
                      updateProxmox({ startOnBoot: e.target.checked })
                    }
                  />
                }
                label="Start on boot"
              />
            </Grid>
          </Grid>

          <Box className={classes.actions}>
            <Button
              variant="contained"
              color="primary"
              startIcon={<SaveIcon />}
              onClick={handleSave}
            >
              Save
            </Button>
            <Button variant="outlined" onClick={handleTestConnection}>
              Test connection
            </Button>
          </Box>

          {lastResult && (
            <Box
              mt={2}
              p={2}
              border={1}
              borderRadius={4}
              borderColor={lastResult.ok ? 'success.main' : 'error.main'}
              bgcolor={lastResult.ok ? 'success.light' : 'error.light'}
              style={{ opacity: 0.95 }}
            >
              <Typography variant="subtitle2">
                {lastResult.ok ? '✓ ' : '✗ '}
                {lastResult.message}
              </Typography>
              <Typography
                variant="caption"
                component="div"
                style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', marginTop: 8 }}
              >
                {[
                  `time:     ${lastResult.timestamp}`,
                  `url:      ${lastResult.url ?? '(not built)'}`,
                  `status:   ${
                    lastResult.status !== undefined
                      ? `${lastResult.status} ${lastResult.statusText ?? ''}`.trim()
                      : '(no response — likely network / CORS / backend down)'
                  }`,
                  `duration: ${
                    lastResult.durationMs !== undefined
                      ? `${lastResult.durationMs}ms`
                      : '-'
                  }`,
                  lastResult.bodySample
                    ? `body:\n${lastResult.bodySample}`
                    : null,
                ]
                  .filter(Boolean)
                  .join('\n')}
              </Typography>
              {!lastResult.ok && (
                <Typography
                  variant="caption"
                  color="textSecondary"
                  component="div"
                  style={{ marginTop: 8 }}
                >
                  Troubleshooting:
                  {proxmox.useBackstageProxy
                    ? ' verify the Backstage backend is running, PROXMOX_API_URL / PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET env vars are set, and the proxy endpoint is registered (curl the URL above from this host).'
                    : ' verify the browser can reach the Proxmox API URL directly (CORS, self-signed TLS and private-network reachability all apply when not using the Backstage proxy).'}
                </Typography>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Nodes table */}
      <Card variant="outlined">
        <CardContent>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Typography variant="h6">Cluster Nodes</Typography>
            <Tooltip title="Fetch the current list of nodes from the Proxmox API">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={
                    loadingNodes ? (
                      <CircularProgress size={16} />
                    ) : (
                      <RefreshIcon />
                    )
                  }
                  onClick={() => loadNodes(false)}
                  disabled={loadingNodes}
                >
                  Refresh
                </Button>
              </span>
            </Tooltip>
          </Box>

          {loadingNodes && nodes.length === 0 ? (
            <Box display="flex" justifyContent="center" p={4}>
              <CircularProgress />
            </Box>
          ) : nodes.length === 0 ? (
            <Paper variant="outlined">
              <Box p={4} textAlign="center">
                <Typography variant="body2" color="textSecondary">
                  No nodes returned. Check the API URL / token above and click
                  "Test connection".
                </Typography>
              </Box>
            </Paper>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Node</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>DHIS2 Instances</TableCell>
                    <TableCell>CPU</TableCell>
                    <TableCell>Memory</TableCell>
                    <TableCell>Disk</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {nodes.map(n => {
                    const nodeInstances = instances.filter(
                      i => i.node === n.node,
                    );
                    const cpuPct = n.maxcpu > 0 ? (n.cpu / 1) * 100 : 0;
                    const memPct =
                      n.maxmem > 0 ? (n.mem / n.maxmem) * 100 : 0;
                    const diskPct =
                      n.maxdisk > 0 ? (n.disk / n.maxdisk) * 100 : 0;
                    return (
                      <TableRow key={n.node}>
                        <TableCell>
                          <strong>{n.node}</strong>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={n.status}
                            size="small"
                            color={n.status === 'online' ? 'primary' : 'default'}
                          />
                        </TableCell>
                        <TableCell>{nodeInstances.length}</TableCell>
                        <TableCell className={classes.usageCell}>
                          <Typography variant="caption">
                            {cpuPct.toFixed(1)}% of {n.maxcpu} vCPU
                          </Typography>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, cpuPct)}
                            className={classes.usageBar}
                          />
                        </TableCell>
                        <TableCell className={classes.usageCell}>
                          <Typography variant="caption">
                            {bytesToGiB(n.mem).toFixed(1)} /{' '}
                            {bytesToGiB(n.maxmem).toFixed(0)} GiB
                          </Typography>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, memPct)}
                            className={classes.usageBar}
                          />
                        </TableCell>
                        <TableCell className={classes.usageCell}>
                          <Typography variant="caption">
                            {bytesToGiB(n.disk).toFixed(0)} /{' '}
                            {bytesToGiB(n.maxdisk).toFixed(0)} GiB
                          </Typography>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, diskPct)}
                            className={classes.usageBar}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Typography
            variant="caption"
            color="textSecondary"
            display="block"
            style={{ marginTop: 12 }}
          >
            Nodes are members of the Proxmox cluster itself — they are added on
            the Proxmox side (e.g. <code>pvecm add &lt;node&gt;</code>) and
            discovered automatically here via the API.
          </Typography>
        </CardContent>
      </Card>

      {/* Cluster CTs (LXC containers) */}
      <Card variant="outlined" className={classes.section}>
        <CardContent>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            mb={2}
            style={{ gap: 16, flexWrap: 'wrap' }}
          >
            <Typography variant="h6">Cluster CTs</Typography>
            <Box display="flex" alignItems="center" style={{ gap: 8, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                variant="outlined"
                placeholder="Search by name, vmid, node, status…"
                value={containerSearch}
                onChange={e => {
                  setContainerSearch(e.target.value);
                  setContainerPage(0);
                }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
                style={{ minWidth: 280 }}
              />
              <Tooltip title="Fetch the current list of LXC containers from the Proxmox API">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={
                      loadingContainers ? (
                        <CircularProgress size={16} />
                      ) : (
                        <RefreshIcon />
                      )
                    }
                    onClick={() => loadContainers(false)}
                    disabled={loadingContainers}
                  >
                    Refresh
                  </Button>
                </span>
              </Tooltip>
            </Box>
          </Box>

          {(() => {
            const q = containerSearch.trim().toLowerCase();
            const filtered = q
              ? containers.filter(c =>
                  [c.name, String(c.vmid), c.node, c.status, c.tags]
                    .filter(Boolean)
                    .some(v => String(v).toLowerCase().includes(q)),
                )
              : containers;
            const start = containerPage * containerRowsPerPage;
            const paged = filtered.slice(start, start + containerRowsPerPage);

            if (loadingContainers && containers.length === 0) {
              return (
                <Box display="flex" justifyContent="center" p={4}>
                  <CircularProgress />
                </Box>
              );
            }
            if (containers.length === 0) {
              return (
                <Paper variant="outlined">
                  <Box p={4} textAlign="center">
                    <Typography variant="body2" color="textSecondary">
                      No containers returned. Check the API connection above
                      and click "Refresh".
                    </Typography>
                  </Box>
                </Paper>
              );
            }
            return (
              <>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>VMID</TableCell>
                        <TableCell>Name</TableCell>
                        <TableCell>Node</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Tags</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paged.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5}>
                            <Box p={2} textAlign="center">
                              <Typography
                                variant="body2"
                                color="textSecondary"
                              >
                                No containers match "{containerSearch}".
                              </Typography>
                            </Box>
                          </TableCell>
                        </TableRow>
                      ) : (
                        paged.map(c => (
                          <TableRow key={`${c.node}-${c.vmid}`}>
                            <TableCell>
                              <strong>{c.vmid}</strong>
                            </TableCell>
                            <TableCell>{c.name ?? '—'}</TableCell>
                            <TableCell>{c.node}</TableCell>
                            <TableCell>
                              <Chip
                                label={c.status}
                                size="small"
                                color={
                                  c.status === 'running'
                                    ? 'primary'
                                    : 'default'
                                }
                              />
                            </TableCell>
                            <TableCell>
                              {c.tags ? (
                                <Box
                                  display="flex"
                                  flexWrap="wrap"
                                  style={{ gap: 4 }}
                                >
                                  {c.tags
                                    .split(/[;,]/)
                                    .map(t => t.trim())
                                    .filter(Boolean)
                                    .map(t => (
                                      <Chip
                                        key={t}
                                        label={t}
                                        size="small"
                                        variant="outlined"
                                      />
                                    ))}
                                </Box>
                              ) : (
                                <Typography
                                  variant="caption"
                                  color="textSecondary"
                                >
                                  —
                                </Typography>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={filtered.length}
                  page={containerPage}
                  onPageChange={(_e, newPage) => setContainerPage(newPage)}
                  rowsPerPage={containerRowsPerPage}
                  onRowsPerPageChange={e => {
                    setContainerRowsPerPage(parseInt(e.target.value, 10));
                    setContainerPage(0);
                  }}
                  rowsPerPageOptions={[5, 10, 25, 50]}
                />
              </>
            );
          })()}

          <Typography
            variant="caption"
            color="textSecondary"
            display="block"
            style={{ marginTop: 12 }}
          >
            All LXC containers across the cluster, fetched from{' '}
            <code>/cluster/resources?type=vm</code> and filtered to{' '}
            <code>type=lxc</code>.
          </Typography>
        </CardContent>
      </Card>

      {/* Cluster VMs (QEMU virtual machines) */}
      <Card variant="outlined" className={classes.section}>
        <CardContent>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            mb={2}
            style={{ gap: 16, flexWrap: 'wrap' }}
          >
            <Typography variant="h6">Cluster VMs</Typography>
            <Box display="flex" alignItems="center" style={{ gap: 8, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                variant="outlined"
                placeholder="Search by name, vmid, node, status…"
                value={vmSearch}
                onChange={e => {
                  setVmSearch(e.target.value);
                  setVmPage(0);
                }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
                style={{ minWidth: 280 }}
              />
              <Tooltip title="Fetch the current list of QEMU VMs from the Proxmox API">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={
                      loadingVms ? (
                        <CircularProgress size={16} />
                      ) : (
                        <RefreshIcon />
                      )
                    }
                    onClick={() => loadVms(false)}
                    disabled={loadingVms}
                  >
                    Refresh
                  </Button>
                </span>
              </Tooltip>
            </Box>
          </Box>

          {(() => {
            const q = vmSearch.trim().toLowerCase();
            const filtered = q
              ? vms.filter(c =>
                  [c.name, String(c.vmid), c.node, c.status, c.tags]
                    .filter(Boolean)
                    .some(v => String(v).toLowerCase().includes(q)),
                )
              : vms;
            const start = vmPage * vmRowsPerPage;
            const paged = filtered.slice(start, start + vmRowsPerPage);

            if (loadingVms && vms.length === 0) {
              return (
                <Box display="flex" justifyContent="center" p={4}>
                  <CircularProgress />
                </Box>
              );
            }
            if (vms.length === 0) {
              return (
                <Paper variant="outlined">
                  <Box p={4} textAlign="center">
                    <Typography variant="body2" color="textSecondary">
                      No VMs returned. Check the API connection above and
                      click "Refresh".
                    </Typography>
                  </Box>
                </Paper>
              );
            }
            return (
              <>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>VMID</TableCell>
                        <TableCell>Name</TableCell>
                        <TableCell>Node</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Tags</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paged.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5}>
                            <Box p={2} textAlign="center">
                              <Typography
                                variant="body2"
                                color="textSecondary"
                              >
                                No VMs match "{vmSearch}".
                              </Typography>
                            </Box>
                          </TableCell>
                        </TableRow>
                      ) : (
                        paged.map(c => (
                          <TableRow key={`${c.node}-${c.vmid}`}>
                            <TableCell>
                              <strong>{c.vmid}</strong>
                            </TableCell>
                            <TableCell>{c.name ?? '—'}</TableCell>
                            <TableCell>{c.node}</TableCell>
                            <TableCell>
                              <Chip
                                label={c.status}
                                size="small"
                                color={
                                  c.status === 'running'
                                    ? 'primary'
                                    : 'default'
                                }
                              />
                            </TableCell>
                            <TableCell>
                              {c.tags ? (
                                <Box
                                  display="flex"
                                  flexWrap="wrap"
                                  style={{ gap: 4 }}
                                >
                                  {c.tags
                                    .split(/[;,]/)
                                    .map(t => t.trim())
                                    .filter(Boolean)
                                    .map(t => (
                                      <Chip
                                        key={t}
                                        label={t}
                                        size="small"
                                        variant="outlined"
                                      />
                                    ))}
                                </Box>
                              ) : (
                                <Typography
                                  variant="caption"
                                  color="textSecondary"
                                >
                                  —
                                </Typography>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={filtered.length}
                  page={vmPage}
                  onPageChange={(_e, newPage) => setVmPage(newPage)}
                  rowsPerPage={vmRowsPerPage}
                  onRowsPerPageChange={e => {
                    setVmRowsPerPage(parseInt(e.target.value, 10));
                    setVmPage(0);
                  }}
                  rowsPerPageOptions={[5, 10, 25, 50]}
                />
              </>
            );
          })()}

          <Typography
            variant="caption"
            color="textSecondary"
            display="block"
            style={{ marginTop: 12 }}
          >
            All QEMU virtual machines across the cluster, fetched from{' '}
            <code>/cluster/resources?type=vm</code> and filtered to{' '}
            <code>type=qemu</code>.
          </Typography>
        </CardContent>
      </Card>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={3500}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
      />
    </Box>
  );
};
