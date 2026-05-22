import { useEffect, useMemo, useState } from 'react';

import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Button,
  ButtonGroup,
  Chip,
  IconButton,
  CircularProgress,
  Checkbox,
  TextField,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Tooltip,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import AddIcon from '@material-ui/icons/Add';
import CloudIcon from '@material-ui/icons/Cloud';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import RefreshIcon from '@material-ui/icons/Refresh';
import DeleteIcon from '@material-ui/icons/Delete';
import SettingsIcon from '@material-ui/icons/Settings';
import DescriptionIcon from '@material-ui/icons/Description';
import SettingsBackupRestoreIcon from '@material-ui/icons/SettingsBackupRestore';
import BackupIcon from '@material-ui/icons/Backup';
import SwapHorizIcon from '@material-ui/icons/SwapHoriz';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import VpnLockIcon from '@material-ui/icons/VpnLock';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import { DHIS2Instance, ProxyServerSettings } from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { nginxService } from '../services/nginxService';
import { TransferDatabaseDialog } from './TransferDatabaseDialog';
import { EditInstanceDialog } from './UpdateInstanceDialog';
import { DeleteInstanceDialog } from './DeleteInstanceDialog';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

const useStyles = makeStyles(theme => ({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  },
  filterField: {
    minWidth: 180,
  },
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  actionButtons: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginTop: theme.spacing(2),
  },
  instanceCard: {
    marginBottom: theme.spacing(2),
    borderLeft: `4px solid ${theme.palette.primary.main}`,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: theme.spacing(2),
  },
  cardSelect: {
    marginLeft: -theme.spacing(1),
  },
}));

export const getInstanceStatusColor = (
  status: string,
): 'default' | 'primary' | 'secondary' => {
  switch (status) {
    case 'running':
      return 'primary';
    case 'stopped':
      return 'default';
    case 'provisioning':
      return 'secondary';
    default:
      return 'default';
  }
};

export interface DHIS2InstancesPanelProps {
  instances: DHIS2Instance[];
  loading: boolean;
  onCreateInstance: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onViewLogs: (instance: DHIS2Instance) => void;
  onRestore: (instance: DHIS2Instance) => void;
  onDelete: (id: string) => void;
  /**
   * Optional Edit handler owned by the page so it can reuse the same
   * streaming activity-log dialog as Create / Delete.
   */
  onEdit?: (instance: DHIS2Instance, draft: EditDraft) => Promise<void> | void;
  /**
   * Called after the panel mutates an instance (edit, backup, refresh) so
   * the parent can re-load its instance list.
   */
  onChanged?: () => void;
  /**
   * Containers in the Proxmox cluster that carry the `dhis2` tag but
   * are NOT in the backend's instance registry. Surfaced as a banner so
   * the operator can adopt or investigate them.
   */
  unmanagedContainers?: Array<{
    vmid: number;
    node: string;
    name?: string;
    tags?: string;
    status?: string;
  }>;
  /**
   * Optional message describing why reconciliation could not be performed
   * (e.g. Proxmox API not configured). Shown as an info banner.
   */
  reconcileWarning?: string | null;
  /**
   * Names of Proxmox cluster nodes used to populate the node filter.
   * When provided, this list is used verbatim instead of deriving the
   * filter options from the instance list — so empty nodes still appear.
   */
  clusterNodes?: string[];
}

type Severity = 'success' | 'error' | 'info';

interface EditDraft {
  name: string;
  version: string;
  cpu: number;
  memoryMb: number;
  storageGb: number;
  dbName: string;
  dbUser: string;
  dbHost: string;
  dbPort: number;
  dbPassword: string;
}

const DEFAULT_PG_PORT = 5432;

/**
 * Map a `driftStatus` from the backend reconciler into a small chip
 * descriptor. `managed` (healthy) and `unknown` (no Proxmox API) are
 * deliberately not rendered to avoid noise on the cards.
 */
const driftChipFor = (
  status: DHIS2Instance['driftStatus'],
):
  | { label: string; tooltip: string; color: 'default' | 'secondary' }
  | null => {
  switch (status) {
    case 'missing':
      return {
        label: 'Missing on Proxmox',
        tooltip:
          'This instance is registered with Backstage but the underlying LXC no longer exists on the Proxmox cluster. Investigate or delete the registry entry.',
        color: 'secondary',
      };
    case 'untagged':
      return {
        label: 'Untagged',
        tooltip:
          'The LXC exists but is missing the `dhis2` tag in Proxmox. The reconciler may stop recognising it as managed by this plugin. Re-apply the tag in the PVE UI.',
        color: 'default',
      };
    default:
      return null;
  }
};

const formatRelative = (iso?: string): string => {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
};

const proxyUseStyles = makeStyles(theme => ({
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  actionButtons: {
    display: 'flex',
    gap: theme.spacing(1),
    marginTop: theme.spacing(2),
  },
  instanceCard: {
    marginBottom: theme.spacing(2),
    borderLeft: `4px solid ${theme.palette.primary.main}`,
  },
  logViewer: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    background: theme.palette.background.default,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(1.5),
    maxHeight: 480,
    overflow: 'auto',
  },
}));

type LogKind = 'access' | 'error';

interface LogsView {
  open: boolean;
  domain?: string;
  kind: LogKind;
  loading: boolean;
  lines: string[];
}

const EMPTY_LOGS: LogsView = {
  open: false,
  kind: 'access',
  loading: false,
  lines: [],
};

type ProxyPanelProps = {
  instances: DHIS2Instance[];
  loading: boolean;
  onViewLogs: (instance: DHIS2Instance) => void;
};

const ProxyPanel = ({
  instances,
  loading,
  onViewLogs,
}: ProxyPanelProps) => {
  const classes = proxyUseStyles();
  const [proxyDefaults, setProxyDefaults] = useState<ProxyServerSettings>(
    () => settingsService.load().proxy,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<ProxyServerSettings>(proxyDefaults);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    open: boolean;
    severity: 'success' | 'error' | 'info';
    message: string;
  }>({ open: false, severity: 'info', message: '' });
  const [disabledSites, setDisabledSites] = useState<Record<string, boolean>>(
    {},
  );
  const [logsView, setLogsView] = useState<LogsView>(EMPTY_LOGS);

  const notify = (
    severity: 'success' | 'error' | 'info',
    message: string,
  ) => setToast({ open: true, severity, message });

  const runAction = async (key: string, label: string, fn: () => Promise<void | string>) => {
    setBusy(key);
    try {
      const result = await fn();
      notify('success', typeof result === 'string' ? result : `${label} succeeded`);
    } catch (e: any) {
      notify('error', `${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleTestConfig = () =>
    runAction('test', 'Config test', async () => {
      const res = await nginxService.testConfig();
      if (!res.success) throw new Error(res.message);
      return res.message;
    });

  const handleReloadNginx = () =>
    runAction('reload', 'Nginx reload', () => nginxService.reload());

  const openProxyLogs = async (kind: LogKind, domain?: string) => {
    setLogsView({ open: true, kind, domain, loading: true, lines: [] });
    try {
      const lines =
        kind === 'access'
          ? await nginxService.getAccessLog(domain)
          : await nginxService.getErrorLog(domain);
      setLogsView(v => ({ ...v, loading: false, lines }));
    } catch (e: any) {
      setLogsView(v => ({
        ...v,
        loading: false,
        lines: [`Failed to load logs: ${e?.message ?? e}`],
      }));
    }
  };

  const refreshLogs = () => {
    if (logsView.open) openProxyLogs(logsView.kind, logsView.domain);
  };

  const closeLogs = () => setLogsView(EMPTY_LOGS);

  const toggleSite = (domain: string, enabled: boolean) =>
    runAction(
      `toggle:${domain}`,
      enabled ? `Enable ${domain}` : `Disable ${domain}`,
      async () => {
        if (enabled) await nginxService.enableSite(domain);
        else await nginxService.disableSite(domain);
        setDisabledSites(prev => ({ ...prev, [domain]: !enabled }));
      },
    );

  const reloadSite = (domain: string) =>
    runAction(`reload:${domain}`, `Reload ${domain}`, () =>
      nginxService.reloadSite(domain),
    );

  const removeSite = (domain: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove nginx site config for ${domain}?`)) return;
    runAction(`remove:${domain}`, `Remove ${domain}`, () =>
      nginxService.removeServer(domain),
    );
  };

  const renewSsl = (domain: string) =>
    runAction(`ssl:${domain}`, `Renew SSL for ${domain}`, () =>
      nginxService.requestCertificate(domain, proxyDefaults.letsencryptEmail ?? ''),
    );

  const openSettings = () => {
    setDraft(proxyDefaults);
    setSettingsOpen(true);
  };
  const closeSettings = () => setSettingsOpen(false);
  const saveSettings = () => {
    const current = settingsService.load();
    settingsService.save({ ...current, proxy: draft });
    setProxyDefaults(draft);
    setSettingsOpen(false);
  };
  const updateDraft = <K extends keyof ProxyServerSettings>(
    key: K,
    value: ProxyServerSettings[K],
  ) => setDraft(prev => ({ ...prev, [key]: value }));

  const settingsButton = (
    <Button
      variant="outlined"
      size="small"
      startIcon={<SettingsIcon />}
      onClick={openSettings}
    >
      Proxy Settings
    </Button>
  );

  const toolbar = (
    <Box
      display="flex"
      flexWrap="wrap"
      alignItems="center"
      style={{ gap: 8 }}
    >
      <ButtonGroup size="small" variant="outlined">
        <Button
          startIcon={
            busy === 'test' ? (
              <CircularProgress size={14} />
            ) : (
              <CheckCircleIcon />
            )
          }
          onClick={handleTestConfig}
          disabled={!!busy}
        >
          Test Config
        </Button>
        <Button
          startIcon={
            busy === 'reload' ? <CircularProgress size={14} /> : <RefreshIcon />
          }
          onClick={handleReloadNginx}
          disabled={!!busy}
        >
          Reload Nginx
        </Button>
        <Button
          startIcon={<DescriptionIcon />}
          onClick={() => openProxyLogs('access')}
          disabled={!!busy}
        >
          Access Log
        </Button>
        <Button
          startIcon={<DescriptionIcon />}
          onClick={() => openProxyLogs('error')}
          disabled={!!busy}
        >
          Error Log
        </Button>
      </ButtonGroup>
      {settingsButton}
    </Box>
  );

  const logsDialog = (
    <Dialog open={logsView.open} onClose={closeLogs} maxWidth="md" fullWidth>
      <DialogTitle>
        Nginx {logsView.kind === 'access' ? 'access' : 'error'} log
        {logsView.domain ? ` — ${logsView.domain}` : ' — global'}
      </DialogTitle>
      <DialogContent dividers>
        {logsView.loading ? (
          <Box display="flex" justifyContent="center" p={4}>
            <CircularProgress />
          </Box>
        ) : logsView.lines.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            No log entries.
          </Typography>
        ) : (
          <Box className={classes.logViewer}>{logsView.lines.join('\n')}</Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={refreshLogs} startIcon={<RefreshIcon />}>
          Refresh
        </Button>
        <Button onClick={closeLogs}>Close</Button>
      </DialogActions>
    </Dialog>
  );

  const toastNode = (
    <Snackbar
      open={toast.open}
      autoHideDuration={4000}
      onClose={() => setToast(t => ({ ...t, open: false }))}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert
        severity={toast.severity}
        onClose={() => setToast(t => ({ ...t, open: false }))}
        variant="filled"
      >
        {toast.message}
      </Alert>
    </Snackbar>
  );

  const settingsDialog = (
    <Dialog open={settingsOpen} onClose={closeSettings} maxWidth="sm" fullWidth>
      <DialogTitle>Reverse Proxy Settings</DialogTitle>
      <DialogContent>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField
              label="Proxy host"
              fullWidth
              value={draft.host}
              onChange={e => updateDraft('host', e.target.value)}
              helperText="SSH-reachable hostname or IP of the proxy server"
              placeholder="10.20.30.143"
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH port"
              type="number"
              fullWidth
              value={draft.sshPort}
              onChange={e =>
                updateDraft('sshPort', Number(e.target.value) || 22)
              }
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH user"
              fullWidth
              value={draft.sshUser}
              onChange={e => updateDraft('sshUser', e.target.value)}
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH auth"
              select
              fullWidth
              value={draft.authMethod}
              onChange={e =>
                updateDraft(
                  'authMethod',
                  e.target.value as ProxyServerSettings['authMethod'],
                )
              }
            >
              <MenuItem value="ssh-key">ssh-key</MenuItem>
              <MenuItem value="password">password</MenuItem>
            </TextField>
          </Grid>
          {draft.authMethod === 'ssh-key' ? (
            <Grid item xs={12}>
              <TextField
                label="SSH private key path"
                fullWidth
                value={draft.sshKeyPath ?? ''}
                onChange={e => updateDraft('sshKeyPath', e.target.value)}
                helperText="Path on the Backstage backend host"
                placeholder="/root/.ssh/id_ed25519"
              />
            </Grid>
          ) : (
            <Grid item xs={12}>
              <TextField
                label="SSH password"
                type="password"
                fullWidth
                value={draft.sshPassword ?? ''}
                onChange={e => updateDraft('sshPassword', e.target.value)}
                helperText="Stored locally in browser settings"
              />
            </Grid>
          )}
          <Grid item xs={12}>
            <TextField
              label="Nginx config directory"
              fullWidth
              value={draft.nginxConfigPath}
              onChange={e => updateDraft('nginxConfigPath', e.target.value)}
              helperText="e.g. /etc/nginx/upstream — directory for per-instance snippets (one <instance>.conf per instance, no subfolders). Created if missing."
              placeholder="/etc/nginx/upstream"
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Nginx reload command"
              fullWidth
              value={draft.nginxReloadCommand}
              onChange={e => updateDraft('nginxReloadCommand', e.target.value)}
              placeholder="sudo systemctl reload nginx"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeSettings}>Cancel</Button>
        <Button onClick={saveSettings} color="primary" variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (instances.length === 0) {
    return (
      <>
        <Box
          display="flex"
          justifyContent="flex-end"
          mb={2}
        >
          {toolbar}
        </Box>
        <Box textAlign="center" p={4}>
          <Typography variant="h6" color="textSecondary">
            No proxy mappings
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Create a DHIS2 instance to publish it through the reverse proxy.
          </Typography>
        </Box>
        {settingsDialog}
        {logsDialog}
        {toastNode}
      </>
    );
  }

  return (
    <>
      <Box
        mb={2}
        display="flex"
        justifyContent="space-between"
        alignItems="flex-start"
        flexWrap="wrap"
        style={{ gap: 16 }}
      >
        <Box>
          <Typography variant="h6" gutterBottom>
            Reverse Proxy
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Proxy host <strong>{proxyDefaults.host || '—'}</strong> routes
            traffic to each DHIS2 instance using the configured base domain and
            SSL settings. Per-instance overrides set in the Create dialog take
            precedence over these defaults.
          </Typography>
        </Box>
        {toolbar}
      </Box>
      <Grid container spacing={3}>
        {instances.map(instance => {
          const scheme = proxyDefaults.forceHttps ? 'https' : 'http';
          const publicUrl =
            proxyDefaults.mode === 'subdomain'
              ? `${scheme}://${instance.name}.${proxyDefaults.baseDomain}`
              : `${scheme}://${proxyDefaults.baseDomain}/${instance.name}`;
          return (
            <Grid item xs={12} key={instance.id}>
              <Card className={classes.instanceCard}>
                <CardContent>
                  <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                    <Box>
                      <Typography variant="h5" gutterBottom>
                        {instance.name}
                        <Chip
                          label={instance.status}
                          color={getInstanceStatusColor(instance.status)}
                          size="small"
                          className={classes.statusChip}
                        />
                        <Chip
                          label={proxyDefaults.mode === 'subdomain' ? 'subdomain' : 'path'}
                          size="small"
                          variant="outlined"
                          className={classes.statusChip}
                        />
                        {proxyDefaults.forceHttps && (
                          <Chip
                            label="HTTPS"
                            color="primary"
                            size="small"
                            className={classes.statusChip}
                          />
                        )}
                        {proxyDefaults.enableHsts && (
                          <Chip
                            label="HSTS"
                            size="small"
                            variant="outlined"
                            className={classes.statusChip}
                          />
                        )}
                        {disabledSites[instance.domain] && (
                          <Chip
                            label="DISABLED"
                            size="small"
                            color="secondary"
                            className={classes.statusChip}
                          />
                        )}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        <strong>Public URL:</strong>{' '}
                        <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                          {publicUrl}
                        </a>
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        <strong>Domain:</strong> {instance.domain}
                      </Typography>
                      <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>
                        <strong>Upstream:</strong> Container {instance.vmid}:
                        {proxyDefaults.upstreamPort} on node {instance.node}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        <strong>Proxy host:</strong> {proxyDefaults.host || '—'} (SSH{' '}
                        {proxyDefaults.sshUser}@{proxyDefaults.host || '?'}:
                        {proxyDefaults.sshPort})
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        <strong>SSL:</strong>{' '}
                        {proxyDefaults.sslProvider === 'letsencrypt'
                          ? `Let's Encrypt (${proxyDefaults.letsencryptEmail || 'no email'})`
                          : proxyDefaults.sslProvider === 'manual'
                            ? `Manual (${proxyDefaults.sslCertPath || 'cert?'})`
                            : 'None (HTTP only)'}
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        <strong>Nginx config:</strong> {proxyDefaults.nginxConfigPath}/
                        {instance.name}.conf
                      </Typography>
                    </Box>
                    <Box className={classes.actionButtons}>
                      <IconButton
                        title="Open public URL"
                        onClick={() =>
                          window.open(publicUrl, '_blank', 'noopener,noreferrer')
                        }
                      >
                        <CloudIcon />
                      </IconButton>
                      <IconButton
                        title="View instance logs"
                        onClick={() => onViewLogs(instance)}
                      >
                        <DescriptionIcon />
                      </IconButton>
                      <IconButton
                        title="View nginx access log for this site"
                        onClick={() => openProxyLogs('access', instance.domain)}
                      >
                        <VisibilityIcon />
                      </IconButton>
                      <IconButton
                        title="View nginx error log for this site"
                        onClick={() => openProxyLogs('error', instance.domain)}
                      >
                        <VisibilityOffIcon />
                      </IconButton>
                      <IconButton
                        title="Reload nginx for this site"
                        disabled={busy === `reload:${instance.domain}`}
                        onClick={() => reloadSite(instance.domain)}
                      >
                        {busy === `reload:${instance.domain}` ? (
                          <CircularProgress size={20} />
                        ) : (
                          <RefreshIcon />
                        )}
                      </IconButton>
                      <IconButton
                        title="Renew SSL certificate"
                        disabled={busy === `ssl:${instance.domain}`}
                        onClick={() => renewSsl(instance.domain)}
                      >
                        {busy === `ssl:${instance.domain}` ? (
                          <CircularProgress size={20} />
                        ) : (
                          <VpnLockIcon />
                        )}
                      </IconButton>
                      <IconButton
                        title={
                          disabledSites[instance.domain]
                            ? 'Enable site'
                            : 'Disable site'
                        }
                        disabled={busy === `toggle:${instance.domain}`}
                        onClick={() =>
                          toggleSite(
                            instance.domain,
                            !!disabledSites[instance.domain],
                          )
                        }
                      >
                        {busy === `toggle:${instance.domain}` ? (
                          <CircularProgress size={20} />
                        ) : disabledSites[instance.domain] ? (
                          <CheckCircleIcon />
                        ) : (
                          <SettingsIcon />
                        )}
                      </IconButton>
                      <IconButton
                        title="Remove site"
                        color="secondary"
                        disabled={busy === `remove:${instance.domain}`}
                        onClick={() => removeSite(instance.domain)}
                      >
                        {busy === `remove:${instance.domain}` ? (
                          <CircularProgress size={20} />
                        ) : (
                          <DeleteIcon />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>
      {settingsDialog}
      {logsDialog}
      {toastNode}
    </>
  );
};

export const DHIS2InstancesPanel = ({
  instances,
  loading,
  onCreateInstance,
  onStart,
  onStop,
  onRestart,
  onViewLogs,
  onRestore,
  onDelete,
  onEdit,
  onChanged,
  unmanagedContainers = [],
  reconcileWarning = null,
  clusterNodes,
}: DHIS2InstancesPanelProps) => {
  const classes = useStyles();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [nodeFilter, setNodeFilter] = useState<string>('all');

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [localBackups, setLocalBackups] = useState<Record<string, string>>({});

  const [editTarget, setEditTarget] = useState<DHIS2Instance | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [versions, setVersions] = useState<string[]>([]);

  // Per-instance nginx proxy files (upstream + vhost / "dhis.conf").
  // Loaded on demand inside the Edit dialog and edited in two textareas.
  const [proxyFilesState, setProxyFilesState] = useState<{
    loading: boolean;
    error: string | null;
    upstreamPath: string;
    upstreamContent: string;
    upstreamExists: boolean;
    sitePath: string;
    siteContent: string;
    siteExists: boolean;
    saving: boolean;
  }>({
    loading: false,
    error: null,
    upstreamPath: '',
    upstreamContent: '',
    upstreamExists: false,
    sitePath: '',
    siteContent: '',
    siteExists: false,
    saving: false,
  });
  const discoveryApi = useApi(discoveryApiRef);
  const { fetch: backstageFetch } = useApi(fetchApiRef);

  const [transferTarget, setTransferTarget] = useState<DHIS2Instance | null>(
    null,
  );

  const [deleteTarget, setDeleteTarget] = useState<DHIS2Instance | null>(null);

  const [confirm, setConfirm] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [toast, setToast] = useState<{
    open: boolean;
    severity: Severity;
    message: string;
  }>({ open: false, severity: 'info', message: '' });

  const notify = (severity: Severity, message: string) =>
    setToast({ open: true, severity, message });

  const setBusyKey = (key: string, on: boolean) =>
    setBusy(prev => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const runAction = async (
    key: string,
    label: string,
    fn: () => Promise<void>,
  ) => {
    setBusyKey(key, true);
    try {
      await fn();
      notify('success', `${label} completed`);
    } catch (e: any) {
      notify('error', `${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusyKey(key, false);
    }
  };

  useEffect(() => {
    if (editTarget && versions.length === 0) {
      dhis2Service.getVersions().then(setVersions).catch(() => {});
    }
  }, [editTarget, versions.length]);

  // Node filter options. Prefer the live list of Proxmox cluster nodes
  // passed in by the parent so the dropdown reflects the cluster even
  // when no instances exist yet on a given node; fall back to nodes
  // derived from the instance list when the cluster list is unavailable.
  const nodes = useMemo(() => {
    if (clusterNodes && clusterNodes.length > 0) {
      return Array.from(new Set(clusterNodes)).sort();
    }
    return Array.from(new Set(instances.map(i => i.node))).sort();
  }, [clusterNodes, instances]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return instances.filter(i => {
      if (statusFilter !== 'all' && i.status !== statusFilter) return false;
      if (nodeFilter !== 'all' && i.node !== nodeFilter) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.domain.toLowerCase().includes(q) ||
        i.vmid.toLowerCase().includes(q) ||
        i.database.name.toLowerCase().includes(q)
      );
    });
  }, [instances, search, statusFilter, nodeFilter]);

  const selectedInstances = filtered.filter(i => selected.has(i.id));

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allFilteredSelected =
    filtered.length > 0 && filtered.every(i => selected.has(i.id));

  const toggleSelectAll = () =>
    setSelected(prev => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filtered.forEach(i => next.delete(i.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach(i => next.add(i.id));
      return next;
    });

  const confirmThen = (title: string, message: string, fn: () => void) =>
    setConfirm({ open: true, title, message, onConfirm: fn });

  const handleStop = (instance: DHIS2Instance) =>
    confirmThen(
      'Stop instance',
      `Stop "${instance.name}"? Active users will be disconnected.`,
      () => onStop(instance.id),
    );

  const handleRestart = (instance: DHIS2Instance) =>
    confirmThen(
      'Restart instance',
      `Restart "${instance.name}"? The instance will be unavailable for ~30s.`,
      () => onRestart(instance.id),
    );

  const handleDelete = (instance: DHIS2Instance) =>
    setDeleteTarget(instance);

  const handleRefreshOne = (instance: DHIS2Instance) =>
    runAction(`refresh:${instance.id}`, `Refresh ${instance.name}`, async () => {
      await dhis2Service.refreshInstance(instance.id);
      onChanged?.();
    });

  const handleBackup = (instance: DHIS2Instance) =>
    runAction(`backup:${instance.id}`, `Backup ${instance.name}`, async () => {
      const res = await dhis2Service.backupInstance(instance.id);
      setLocalBackups(prev => ({ ...prev, [instance.id]: res.timestamp }));
      onChanged?.();
    });

  const proxyPayloadFromSettings = () => {
    const s = settingsService.load();
    return {
      proxy: {
        host: s.proxy.host || undefined,
        sshPort: s.proxy.sshPort || undefined,
        sshUser: s.proxy.sshUser || undefined,
        sshKeyPath: s.proxy.sshKeyPath || undefined,
        nginxConfigPath: s.proxy.nginxConfigPath || undefined,
        nginxReloadCommand: s.proxy.nginxReloadCommand || undefined,
      },
    };
  };

  const loadProxyFiles = async (instance: DHIS2Instance) => {
    setProxyFilesState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const snap = await dhis2Service.readProxyFiles(
        baseUrl,
        instance.id,
        proxyPayloadFromSettings(),
        backstageFetch,
      );
      setProxyFilesState({
        loading: false,
        error: null,
        upstreamPath: snap.upstream.path,
        upstreamContent: snap.upstream.content,
        upstreamExists: snap.upstream.exists,
        sitePath: snap.site.path,
        siteContent: snap.site.content,
        siteExists: snap.site.exists,
        saving: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProxyFilesState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  };

  const handleOpenEdit = (instance: DHIS2Instance) => {
    setEditTarget(instance);
    const globalSettings = settingsService.load();
    setEditDraft({
      name: instance.name,
      version: instance.version,
      cpu: instance.resources.cpu,
      memoryMb: instance.resources.memory,
      storageGb: instance.resources.storage,
      dbName: instance.database.name,
      dbUser: instance.database.user,
      // Fall back to the global "Database Configurations" host that was
      // used at Create-Instance time — older instance records were
      // persisted without the per-instance `database.host` field.
      dbHost: instance.database.host ?? globalSettings.dhis2.postgresHost ?? '',
      dbPort:
        instance.database.port ??
        globalSettings.dhis2.postgresPort ??
        DEFAULT_PG_PORT,
      dbPassword: instance.database.password ?? '',
    });
    setProxyFilesState({
      loading: false,
      error: null,
      upstreamPath: '',
      upstreamContent: '',
      upstreamExists: false,
      sitePath: '',
      siteContent: '',
      siteExists: false,
      saving: false,
    });
    // Best-effort load — failures surface inline in the proxy-files block.
    void loadProxyFiles(instance);
  };

  const handleSaveProxyFiles = async () => {
    if (!editTarget) return;
    setProxyFilesState(prev => ({ ...prev, saving: true, error: null }));
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      await dhis2Service.writeProxyFiles(
        baseUrl,
        editTarget.id,
        {
          ...proxyPayloadFromSettings(),
          upstream: proxyFilesState.upstreamContent,
          site: proxyFilesState.siteContent,
          reload: true,
        },
        backstageFetch,
      );
      setProxyFilesState(prev => ({
        ...prev,
        saving: false,
        upstreamExists: true,
        siteExists: true,
      }));
      setToast({
        open: true,
        severity: 'success',
        message: `Proxy files saved and nginx reloaded for ${editTarget.name}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProxyFilesState(prev => ({
        ...prev,
        saving: false,
        error: message,
      }));
    }
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editDraft) return;
    const target = editTarget;
    const draft = editDraft;
    setEditTarget(null);
    setEditDraft(null);
    await runAction(`edit:${target.id}`, `Update ${target.name}`, async () => {
      if (onEdit) {
        await onEdit(target, draft);
      }
      onChanged?.();
    });
  };

  const bulkStart = () =>
    selectedInstances
      .filter(i => i.status === 'stopped')
      .forEach(i => onStart(i.id));

  const bulkStop = () =>
    confirmThen(
      'Stop selected',
      `Stop ${selectedInstances.length} instance(s)?`,
      () =>
        selectedInstances
          .filter(i => i.status === 'running')
          .forEach(i => onStop(i.id)),
    );

  const bulkBackup = () => selectedInstances.forEach(i => handleBackup(i));

  const renderToolbar = () => (
    <Box className={classes.toolbar}>
      <TextField
        className={classes.filterField}
        label="Search"
        size="small"
        variant="outlined"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="name, domain, VMID, db"
      />
      <TextField
        className={classes.filterField}
        select
        label="Status"
        size="small"
        variant="outlined"
        value={statusFilter}
        onChange={e => setStatusFilter(e.target.value)}
      >
        <MenuItem value="all">All statuses</MenuItem>
        <MenuItem value="running">Running</MenuItem>
        <MenuItem value="stopped">Stopped</MenuItem>
        <MenuItem value="provisioning">Provisioning</MenuItem>
        <MenuItem value="error">Error</MenuItem>
      </TextField>
      <TextField
        className={classes.filterField}
        select
        label="Node"
        size="small"
        variant="outlined"
        value={nodeFilter}
        onChange={e => setNodeFilter(e.target.value)}
      >
        <MenuItem value="all">All nodes</MenuItem>
        {nodes.map(n => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      <Box flexGrow={1} />
      <Typography variant="body2" color="textSecondary">
        {filtered.length} of {instances.length} shown · {selected.size} selected
      </Typography>
      <ButtonGroup
        size="small"
        variant="outlined"
        disabled={selected.size === 0}
      >
        <Button startIcon={<PlayArrowIcon />} onClick={bulkStart}>
          Start
        </Button>
        <Button startIcon={<StopIcon />} onClick={bulkStop}>
          Stop
        </Button>
        <Button startIcon={<BackupIcon />} onClick={bulkBackup}>
          Backup
        </Button>
      </ButtonGroup>
      <Button
        variant="outlined"
        size="small"
        onClick={toggleSelectAll}
        disabled={filtered.length === 0}
      >
        {allFilteredSelected ? 'Clear selection' : 'Select all'}
      </Button>
      <Button
        variant="contained"
        color="primary"
        size="small"
        startIcon={<AddIcon />}
        onClick={onCreateInstance}
      >
        Create Instance
      </Button>
    </Box>
  );

  const renderInstanceCard = (instance: DHIS2Instance) => {
    const isBusy = (action: string) => busy.has(`${action}:${instance.id}`);
    const lastBackup = instance.lastBackup ?? localBackups[instance.id];
    return (
      <Grid item xs={12} key={instance.id}>
        <Card className={classes.instanceCard}>
          <CardContent>
            <Box className={classes.cardHeader}>
              <Box display="flex" alignItems="flex-start">
                <Checkbox
                  className={classes.cardSelect}
                  checked={selected.has(instance.id)}
                  onChange={() => toggleSelect(instance.id)}
                  inputProps={{ 'aria-label': `Select ${instance.name}` }}
                />
                <Box>
                  <Typography variant="h5" gutterBottom>
                    {instance.name}
                    <Chip
                      label={instance.status}
                      color={getInstanceStatusColor(instance.status)}
                      size="small"
                      className={classes.statusChip}
                    />
                    {(() => {
                      const drift = driftChipFor(instance.driftStatus);
                      if (!drift) return null;
                      return (
                        <Tooltip title={drift.tooltip}>
                          <Chip
                            label={drift.label}
                            color={drift.color}
                            size="small"
                            variant="outlined"
                            className={classes.statusChip}
                          />
                        </Tooltip>
                      );
                    })()}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Version:</strong> {instance.version} |{' '}
                    <strong>Node:</strong> {instance.node} |{' '}
                    <strong>VMID:</strong> {instance.vmid}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>URL:</strong>{' '}
                    <a
                      href={instance.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {instance.domain}
                    </a>
                  </Typography>
                  <Typography
                    variant="body2"
                    color="textSecondary"
                    style={{ marginTop: 8 }}
                  >
                    <strong>Resources:</strong> {instance.resources.cpu} vCPU |{' '}
                    {(instance.resources.memory / 1024).toFixed(1)} GB RAM |{' '}
                    {instance.resources.storage} GB Storage
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Database:</strong> {instance.database.name} (User:{' '}
                    {instance.database.user})
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Last backup:</strong> {formatRelative(lastBackup)}
                    {lastBackup && (
                      <Typography
                        component="span"
                        variant="caption"
                        color="textSecondary"
                        style={{ marginLeft: 8 }}
                      >
                        ({new Date(lastBackup).toLocaleString()})
                      </Typography>
                    )}
                  </Typography>
                </Box>
              </Box>
              <Box className={classes.actionButtons}>
                <Tooltip title="Open DHIS2 in new tab">
                  <IconButton
                    onClick={() =>
                      window.open(
                        instance.url,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    <OpenInNewIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Refresh status">
                  <IconButton
                    onClick={() => handleRefreshOne(instance)}
                    disabled={isBusy('refresh')}
                  >
                    {isBusy('refresh') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <RefreshIcon />
                    )}
                  </IconButton>
                </Tooltip>
                {instance.status === 'stopped' && (
                  <Tooltip title="Start">
                    <IconButton
                      color="primary"
                      onClick={() => onStart(instance.id)}
                    >
                      <PlayArrowIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {instance.status === 'running' && (
                  <Tooltip title="Stop">
                    <IconButton
                      color="secondary"
                      onClick={() => handleStop(instance)}
                    >
                      <StopIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {instance.status === 'running' && (
                  <Tooltip title="Restart">
                    <IconButton onClick={() => handleRestart(instance)}>
                      <RefreshIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="View logs">
                  <IconButton onClick={() => onViewLogs(instance)}>
                    <DescriptionIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Backup now">
                  <IconButton
                    onClick={() => handleBackup(instance)}
                    disabled={isBusy('backup')}
                  >
                    {isBusy('backup') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <BackupIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Restore from backup">
                  <IconButton onClick={() => onRestore(instance)}>
                    <SettingsBackupRestoreIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Transfer database to another server">
                  <IconButton onClick={() => setTransferTarget(instance)}>
                    <SwapHorizIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Edit settings">
                  <IconButton
                    onClick={() => handleOpenEdit(instance)}
                    disabled={isBusy('edit')}
                  >
                    {isBusy('edit') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <SettingsIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton
                    color="secondary"
                    onClick={() => handleDelete(instance)}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
    );
  };

  const editDialog = (
    <EditInstanceDialog
      open={!!editTarget}
      instance={editTarget}
      draft={editDraft}
      versions={versions}
      proxyFilesState={proxyFilesState}
      onClose={() => {
        setEditTarget(null);
        setEditDraft(null);
      }}
      onDraftChange={setEditDraft}
      onProxyFilesChange={setProxyFilesState}
      onReloadProxyFiles={() => {
        if (editTarget) void loadProxyFiles(editTarget);
      }}
      onSaveProxyFiles={handleSaveProxyFiles}
      onSave={handleSaveEdit}
    />
  );

  const deleteDialog = (
    <DeleteInstanceDialog
      open={!!deleteTarget}
      instance={deleteTarget}
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => {
        if (!deleteTarget) return;
        onDelete(deleteTarget.id);
        setDeleteTarget(null);
      }}
    />
  );

  const confirmDialog = (
    <Dialog
      open={!!confirm?.open}
      onClose={() => setConfirm(null)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{confirm?.title}</DialogTitle>
      <DialogContent>
        <Typography>{confirm?.message}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirm(null)}>Cancel</Button>
        <Button
          color="secondary"
          variant="contained"
          onClick={() => {
            confirm?.onConfirm();
            setConfirm(null);
          }}
        >
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );

  const toastNode = (
    <Snackbar
      open={toast.open}
      autoHideDuration={4000}
      onClose={() => setToast(t => ({ ...t, open: false }))}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert
        severity={toast.severity}
        onClose={() => setToast(t => ({ ...t, open: false }))}
        variant="filled"
      >
        {toast.message}
      </Alert>
    </Snackbar>
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (instances.length === 0) {
    return (
      <>
        <Box textAlign="center" p={4}>
          <Typography variant="h6" color="textSecondary">
            No DHIS2 instances found
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Create your first DHIS2 instance to get started
          </Typography>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={onCreateInstance}
          >
            Create Instance
          </Button>
        </Box>
        <Box mt={3}>
          <ProxyPanel
            instances={instances}
            loading={loading}
            onViewLogs={onViewLogs}
          />
        </Box>
        {toastNode}
      </>
    );
  }

  return (
    <>
      {renderToolbar()}
      {reconcileWarning && (
        <Box mb={2}>
          <Alert severity="info" variant="outlined">
            Proxmox reconciliation is unavailable: {reconcileWarning}
          </Alert>
        </Box>
      )}
      {unmanagedContainers.length > 0 && (
        <Box mb={2}>
          <Alert severity="warning" variant="outlined">
            <Typography variant="body2" gutterBottom>
              <strong>
                {unmanagedContainers.length} DHIS2-tagged container
                {unmanagedContainers.length === 1 ? '' : 's'} on the cluster
                {unmanagedContainers.length === 1 ? ' is' : ' are'} not in the
                Backstage registry.
              </strong>{' '}
              They were likely created outside this plugin. Investigate or
              adopt them so they appear in this list.
            </Typography>
            <Typography variant="caption" component="div">
              {unmanagedContainers
                .slice(0, 10)
                .map(c => `${c.name ?? `vmid-${c.vmid}`} (${c.node}/${c.vmid})`)
                .join(', ')}
              {unmanagedContainers.length > 10 &&
                ` and ${unmanagedContainers.length - 10} more`}
            </Typography>
          </Alert>
        </Box>
      )}
      {filtered.length === 0 ? (
        <Box textAlign="center" p={4}>
          <Typography variant="body2" color="textSecondary">
            No instances match the current filters.
          </Typography>
        </Box>
      ) : (
        <Grid container spacing={3}>
          {filtered.map(renderInstanceCard)}
        </Grid>
      )}
      <Box mt={4}>
        <ProxyPanel
          instances={instances}
          loading={loading}
          onViewLogs={onViewLogs}
        />
      </Box>
      {editDialog}
      {deleteDialog}
      {confirmDialog}
      <TransferDatabaseDialog
        open={!!transferTarget}
        instance={transferTarget}
        onClose={() => setTransferTarget(null)}
        onCompleted={() => {
          notify('success', 'Database transfer completed');
          onChanged?.();
        }}
      />
      {toastNode}
    </>
  );
};
