import { useState } from 'react';
import {
  Box,
  Button,
  Grid,
  Card,
  CardContent,
  Typography,
  Chip,
  IconButton,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  FormControlLabel,
  Switch,
  ButtonGroup,
  Snackbar,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import CloudIcon from '@material-ui/icons/Cloud';
import DescriptionIcon from '@material-ui/icons/Description';
import SettingsIcon from '@material-ui/icons/Settings';
import RefreshIcon from '@material-ui/icons/Refresh';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import DeleteIcon from '@material-ui/icons/Delete';
import VpnLockIcon from '@material-ui/icons/VpnLock';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import { DHIS2Instance, ProxyServerSettings } from '../types';
import { settingsService } from '../services/settingsService';
import { nginxService } from '../services/nginxService';
import { getInstanceStatusColor } from './DHIS2InstancesPanel';

const useStyles = makeStyles(theme => ({
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

export interface DHIS2ProxyPanelProps {
  instances: DHIS2Instance[];
  loading: boolean;
  onViewLogs: (instance: DHIS2Instance) => void;
}

export const DHIS2ProxyPanel = ({
  instances,
  loading,
  onViewLogs,
}: DHIS2ProxyPanelProps) => {
  const classes = useStyles();
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
              label="Target proxy host"
              fullWidth
              value={draft.host}
              onChange={e => updateDraft('host', e.target.value)}
              helperText="Hostname or IP of the dedicated Nginx reverse-proxy server"
              placeholder="proxy.example.org"
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
          <Grid item xs={12}>
            <TextField
              label="Base domain"
              fullWidth
              value={draft.baseDomain}
              onChange={e => updateDraft('baseDomain', e.target.value)}
              helperText={
                draft.mode === 'subdomain'
                  ? 'Instances become <name>.<baseDomain>'
                  : 'Instances become <baseDomain>/<name>'
              }
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="Routing mode"
              select
              fullWidth
              value={draft.mode}
              onChange={e =>
                updateDraft('mode', e.target.value as ProxyServerSettings['mode'])
              }
            >
              <MenuItem value="subdomain">Subdomain</MenuItem>
              <MenuItem value="path">Path</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="Upstream port"
              type="number"
              fullWidth
              value={draft.upstreamPort}
              onChange={e =>
                updateDraft('upstreamPort', Number(e.target.value) || 8080)
              }
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Nginx config path"
              fullWidth
              value={draft.nginxConfigPath}
              onChange={e => updateDraft('nginxConfigPath', e.target.value)}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Nginx reload command"
              fullWidth
              value={draft.nginxReloadCommand}
              onChange={e => updateDraft('nginxReloadCommand', e.target.value)}
            />
          </Grid>
          <Grid item xs={6}>
            <FormControlLabel
              control={
                <Switch
                  checked={draft.forceHttps}
                  onChange={e => updateDraft('forceHttps', e.target.checked)}
                />
              }
              label="Force HTTPS"
            />
          </Grid>
          <Grid item xs={6}>
            <FormControlLabel
              control={
                <Switch
                  checked={draft.enableHsts}
                  onChange={e => updateDraft('enableHsts', e.target.checked)}
                />
              }
              label="Enable HSTS"
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
