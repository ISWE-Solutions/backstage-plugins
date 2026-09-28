import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Switch,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import SaveIcon from '@material-ui/icons/Save';
import { DEFAULT_SETTINGS, DHIS2PluginSettings, ProxmoxNode } from '../types';
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
}));

interface Props {
  /** Notified with fresh nodes after a successful "Test connection". */
  onNodesChange?: (nodes: ProxmoxNode[]) => void;
}

interface TestResult {
  ok: boolean;
  message: string;
  url?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  bodySample?: string;
  timestamp: string;
}

/**
 * Proxmox connection settings used by DHIS2 provisioning (create/clone/update).
 * These override the server-side PROXMOX_* env vars for the run. Cluster
 * monitoring itself lives in the dedicated Proxmox plugin (/proxmox); this form
 * only configures how the DHIS2 orchestrator reaches Proxmox.
 */
export const ProxmoxSettingsPanel = ({ onNodesChange }: Props) => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const [settings, setSettings] = useState<DHIS2PluginSettings>(() =>
    settingsService.load(),
  );
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [lastResult, setLastResult] = useState<TestResult | null>(null);

  const proxmox = settings.proxmox;
  const updateProxmox = (patch: Partial<typeof proxmox>) =>
    setSettings(prev => ({ ...prev, proxmox: { ...prev.proxmox, ...patch } }));

  const clusters = settings.proxmoxClusters ?? [];
  const activeId = settings.activeProxmoxClusterId ?? clusters[0]?.id ?? '';
  const activeName = clusters.find(c => c.id === activeId)?.name ?? '';

  // Fold the working `proxmox` edits back into the active profile.
  const syncActive = (s: DHIS2PluginSettings) =>
    (s.proxmoxClusters ?? []).map(c =>
      c.id === s.activeProxmoxClusterId ? { ...c, ...s.proxmox } : c,
    );

  const switchCluster = (id: string) =>
    setSettings(prev => {
      const synced = syncActive(prev);
      const target = synced.find(c => c.id === id);
      if (!target) return prev;
      const { id: _i, name: _n, ...s } = target;
      return {
        ...prev,
        proxmoxClusters: synced,
        activeProxmoxClusterId: id,
        proxmox: s,
      };
    });

  const addCluster = () =>
    setSettings(prev => {
      const synced = syncActive(prev);
      const id = `c-${Date.now()}`;
      const profile = {
        id,
        name: `Cluster ${synced.length + 1}`,
        ...DEFAULT_SETTINGS.proxmox,
      };
      const { id: _i, name: _n, ...s } = profile;
      return {
        ...prev,
        proxmoxClusters: [...synced, profile],
        activeProxmoxClusterId: id,
        proxmox: s,
      };
    });

  const deleteActive = () =>
    setSettings(prev => {
      const list = prev.proxmoxClusters ?? [];
      if (list.length <= 1) return prev;
      const remaining = list.filter(c => c.id !== prev.activeProxmoxClusterId);
      const { id: _i, name: _n, ...s } = remaining[0];
      return {
        ...prev,
        proxmoxClusters: remaining,
        activeProxmoxClusterId: remaining[0].id,
        proxmox: s,
      };
    });

  const renameActive = (name: string) =>
    setSettings(prev => ({
      ...prev,
      proxmoxClusters: (prev.proxmoxClusters ?? []).map(c =>
        c.id === prev.activeProxmoxClusterId ? { ...c, name } : c,
      ),
    }));

  const handleSave = () => {
    settingsService.save(settings);
    setSnackbar('Proxmox connection settings saved');
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setSnackbar('Testing Proxmox connection…');
    try {
      const result = await dhis2Service.fetchNodes(proxmox, backstageFetch);
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
      setTesting(false);
    }
  };

  return (
    <Box>
      <Card className={classes.section} variant="outlined">
        <CardContent>
          <Typography variant="h6" className={classes.sectionTitle}>
            Clusters
          </Typography>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={4}>
              <TextField
                select
                fullWidth
                label="Active cluster"
                value={activeId}
                onChange={e => switchCluster(e.target.value)}
              >
                {clusters.map(c => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Cluster name"
                value={activeName}
                onChange={e => renameActive(e.target.value)}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <Box display="flex" style={{ gap: 8 }}>
                <Button variant="outlined" onClick={addCluster}>
                  Add cluster
                </Button>
                <Button
                  variant="outlined"
                  onClick={deleteActive}
                  disabled={clusters.length <= 1}
                >
                  Delete
                </Button>
              </Box>
            </Grid>
          </Grid>
          <Typography
            variant="caption"
            color="textSecondary"
            component="p"
            style={{ marginTop: 8 }}
          >
            The active cluster's connection is used by provisioning
            (create/clone/update). Save to persist all clusters.
          </Typography>
        </CardContent>
      </Card>

      <Card className={classes.section} variant="outlined">
        <CardContent>
          <Typography variant="h6" className={classes.sectionTitle}>
            Proxmox Cluster Connection
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Connection details for the Proxmox VE API used to orchestrate LXC
            containers running DHIS2. Use an API token in production.{' '}
            <strong>
              These settings are forwarded to provisioning jobs and override the
              server-side <code>PROXMOX_API_URL</code> /{' '}
              <code>PROXMOX_USER</code> / <code>PROXMOX_TOKEN_ID</code> /{' '}
              <code>PROXMOX_TOKEN_SECRET</code> env vars for that run.
            </strong>{' '}
            For read-only cluster monitoring, see the Proxmox dashboard.
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
                When enabled, calls go to the Backstage proxy path below and the
                API token is injected server-side. When disabled, the browser
                calls the Proxmox API directly (requires CORS and network
                reachability).
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
                    helperText="Full token id e.g. root@pam!backstage"
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
              <Typography
                variant="caption"
                color="textSecondary"
                component="div"
              >
                Leave off when the Proxmox API uses the stock self-signed
                certificate (the default).
              </Typography>
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
                onChange={e => updateProxmox({ rootfsStorage: e.target.value })}
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
                onChange={e => updateProxmox({ networkBridge: e.target.value })}
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
                onChange={e => updateProxmox({ searchDomain: e.target.value })}
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
            <Button
              variant="outlined"
              onClick={handleTestConnection}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </Box>

          {lastResult && (
            <Box
              mt={2}
              p={2}
              border={1}
              borderRadius={4}
              borderColor={lastResult.ok ? 'success.main' : 'error.main'}
              style={{ opacity: 0.95 }}
            >
              <Typography variant="subtitle2">
                {lastResult.ok ? '✓ ' : '✗ '}
                {lastResult.message}
              </Typography>
              <Typography
                variant="caption"
                component="div"
                style={{
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  marginTop: 8,
                }}
              >
                {[
                  `time:     ${lastResult.timestamp}`,
                  `url:      ${lastResult.url ?? '(not built)'}`,
                  `status:   ${
                    lastResult.status !== undefined
                      ? `${lastResult.status} ${
                          lastResult.statusText ?? ''
                        }`.trim()
                      : '(no response — likely network / CORS / backend down)'
                  }`,
                  `duration: ${
                    lastResult.durationMs !== undefined
                      ? `${lastResult.durationMs} ms`
                      : '—'
                  }`,
                  lastResult.bodySample
                    ? `body:     ${lastResult.bodySample}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
      />
    </Box>
  );
};
