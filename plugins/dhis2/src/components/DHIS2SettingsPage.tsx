import React, { useState } from 'react';
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
  Switch,
  TextField,
  Typography,
  Snackbar,
  makeStyles,
} from '@material-ui/core';
import SaveIcon from '@material-ui/icons/Save';
import RestoreIcon from '@material-ui/icons/Restore';
import { DHIS2PluginSettings } from '../types';
import { settingsService } from '../services/settingsService';

const useStyles = makeStyles(theme => ({
  section: {
    marginBottom: theme.spacing(3),
  },
  sectionTitle: {
    marginBottom: theme.spacing(2),
  },
  field: {
    marginBottom: theme.spacing(2),
  },
  actions: {
    display: 'flex',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
  },
  preview: {
    fontFamily: 'monospace',
    backgroundColor: theme.palette.background.default,
    padding: theme.spacing(1, 2),
    borderRadius: 4,
  },
}));

export const DHIS2SettingsPage = () => {
  const classes = useStyles();
  const [settings, setSettings] = useState<DHIS2PluginSettings>(() =>
    settingsService.load(),
  );
  const [snackbar, setSnackbar] = useState<string | null>(null);

  const update = <K extends keyof DHIS2PluginSettings>(
    section: K,
    patch: Partial<DHIS2PluginSettings[K]>,
  ) => {
    setSettings(prev => ({ ...prev, [section]: { ...prev[section], ...patch } }));
  };

  const handleSave = () => {
    settingsService.save(settings);
    setSnackbar('Settings saved');
  };

  const handleReset = () => {
    if (!window.confirm('Reset all DHIS2 plugin settings to defaults?')) return;
    setSettings(settingsService.reset());
    setSnackbar('Settings reset to defaults');
  };

  const { proxy, dhis2 } = settings;

  const examplePreview = (() => {
    const scheme = proxy.forceHttps ? 'https' : 'http';
    if (proxy.mode === 'subdomain') {
      return [
        `${scheme}://hmis.${proxy.baseDomain}`,
        `${scheme}://hmis-dev.${proxy.baseDomain}`,
      ];
    }
    const prefix = proxy.pathPrefix ? `/${proxy.pathPrefix}` : '';
    return [
      `${scheme}://${proxy.baseDomain}${prefix}/hmis`,
      `${scheme}://${proxy.baseDomain}${prefix}/hmis-dev`,
    ];
  })();

  return (
    <Box>
      {/* Proxmox cluster settings have moved to the "Proxmox Cluster" tab. */}

      {/* Proxy server */}
      <Card className={classes.section} variant="outlined">
        <CardContent>
          <Typography variant="h6" className={classes.sectionTitle}>
            Reverse Proxy Server
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            A dedicated proxy server terminates TLS and routes traffic to each
            DHIS2 container. Choose how instance URLs are derived from the base
            domain.
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth className={classes.field}>
                <InputLabel>Routing mode</InputLabel>
                <Select
                  value={proxy.mode}
                  onChange={e =>
                    update('proxy', {
                      mode: e.target.value as 'path' | 'subdomain',
                    })
                  }
                >
                  <MenuItem value="path">Path-based (base/instance)</MenuItem>
                  <MenuItem value="subdomain">
                    Subdomain-based (instance.base)
                  </MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={5}>
              <TextField
                fullWidth
                label="Base domain"
                value={proxy.baseDomain}
                onChange={e => update('proxy', { baseDomain: e.target.value })}
                helperText={
                  proxy.mode === 'path'
                    ? 'e.g. dhis2.example.org — instances become dhis2.example.org/hmis'
                    : 'e.g. example.org — instances become hmis.example.org'
                }
                className={classes.field}
              />
            </Grid>
            {proxy.mode === 'path' && (
              <Grid item xs={12} md={3}>
                <TextField
                  fullWidth
                  label="Path prefix (optional)"
                  value={proxy.pathPrefix ?? ''}
                  onChange={e =>
                    update('proxy', { pathPrefix: e.target.value })
                  }
                  helperText='e.g. "dhis2" → base/dhis2/hmis'
                  className={classes.field}
                />
              </Grid>
            )}

            <Grid item xs={12}>
              <Typography variant="caption" color="textSecondary">
                Example URLs:
              </Typography>
              <Box className={classes.preview} mt={1}>
                {examplePreview.map(u => (
                  <div key={u}>{u}</div>
                ))}
              </Box>
            </Grid>

            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Proxy host"
                value={proxy.host}
                onChange={e => update('proxy', { host: e.target.value })}
                helperText="SSH-reachable hostname or IP of the proxy server"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={6} md={2}>
              <TextField
                fullWidth
                type="number"
                label="SSH port"
                value={proxy.sshPort}
                onChange={e =>
                  update('proxy', { sshPort: parseInt(e.target.value, 10) || 22 })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={6} md={4}>
              <TextField
                fullWidth
                label="SSH user"
                value={proxy.sshUser}
                onChange={e => update('proxy', { sshUser: e.target.value })}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth className={classes.field}>
                <InputLabel>SSH auth</InputLabel>
                <Select
                  value={proxy.authMethod}
                  onChange={e =>
                    update('proxy', {
                      authMethod: e.target.value as 'ssh-key' | 'password',
                    })
                  }
                >
                  <MenuItem value="ssh-key">SSH key</MenuItem>
                  <MenuItem value="password">Password</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            {proxy.authMethod === 'ssh-key' ? (
              <Grid item xs={12} md={8}>
                <TextField
                  fullWidth
                  label="SSH private key path"
                  value={proxy.sshKeyPath ?? ''}
                  onChange={e =>
                    update('proxy', { sshKeyPath: e.target.value })
                  }
                  helperText="Path on the Backstage backend host"
                  className={classes.field}
                />
              </Grid>
            ) : (
              <Grid item xs={12} md={8}>
                <TextField
                  fullWidth
                  type="password"
                  label="SSH password"
                  value={proxy.sshPassword ?? ''}
                  onChange={e =>
                    update('proxy', { sshPassword: e.target.value })
                  }
                  className={classes.field}
                />
              </Grid>
            )}

            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Nginx config directory"
                value={proxy.nginxConfigPath}
                onChange={e =>
                  update('proxy', { nginxConfigPath: e.target.value })
                }
                helperText="e.g. /etc/nginx/conf.d"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Nginx reload command"
                value={proxy.nginxReloadCommand}
                onChange={e =>
                  update('proxy', { nginxReloadCommand: e.target.value })
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} md={4}>
              <FormControl fullWidth className={classes.field}>
                <InputLabel>SSL provider</InputLabel>
                <Select
                  value={proxy.sslProvider}
                  onChange={e =>
                    update('proxy', {
                      sslProvider: e.target.value as
                        | 'letsencrypt'
                        | 'manual'
                        | 'none',
                    })
                  }
                >
                  <MenuItem value="letsencrypt">Let's Encrypt (ACME)</MenuItem>
                  <MenuItem value="manual">Manual certificate</MenuItem>
                  <MenuItem value="none">None (HTTP only)</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            {proxy.sslProvider === 'letsencrypt' && (
              <Grid item xs={12} md={8}>
                <TextField
                  fullWidth
                  label="Let's Encrypt email"
                  value={proxy.letsencryptEmail ?? ''}
                  onChange={e =>
                    update('proxy', { letsencryptEmail: e.target.value })
                  }
                  className={classes.field}
                />
              </Grid>
            )}
            {proxy.sslProvider === 'manual' && (
              <>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="SSL cert path"
                    value={proxy.sslCertPath ?? ''}
                    onChange={e =>
                      update('proxy', { sslCertPath: e.target.value })
                    }
                    className={classes.field}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="SSL key path"
                    value={proxy.sslKeyPath ?? ''}
                    onChange={e =>
                      update('proxy', { sslKeyPath: e.target.value })
                    }
                    className={classes.field}
                  />
                </Grid>
              </>
            )}

            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Upstream port"
                value={proxy.upstreamPort}
                onChange={e =>
                  update('proxy', {
                    upstreamPort: parseInt(e.target.value, 10) || 8080,
                  })
                }
                helperText="Port DHIS2 listens on in the container"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxy.forceHttps}
                    onChange={e =>
                      update('proxy', { forceHttps: e.target.checked })
                    }
                  />
                }
                label="Force HTTPS"
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={
                  <Switch
                    checked={proxy.enableHsts}
                    onChange={e =>
                      update('proxy', { enableHsts: e.target.checked })
                    }
                  />
                }
                label="Enable HSTS"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* DHIS2 defaults */}
      <Card className={classes.section} variant="outlined">
        <CardContent>
          <Typography variant="h6" className={classes.sectionTitle}>
            DHIS2 Provisioning Defaults
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Defaults applied when a new DHIS2 instance is provisioned.
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Default DHIS2 version"
                value={dhis2.defaultVersion}
                onChange={e =>
                  update('dhis2', { defaultVersion: e.target.value })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Java heap (Xmx)"
                value={dhis2.javaHeap}
                onChange={e => update('dhis2', { javaHeap: e.target.value })}
                helperText="e.g. 4g"
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Tomcat port"
                value={dhis2.tomcatPort}
                onChange={e =>
                  update('dhis2', {
                    tomcatPort: parseInt(e.target.value, 10) || 8080,
                  })
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Default CPU cores"
                value={dhis2.defaultCpu}
                onChange={e =>
                  update('dhis2', {
                    defaultCpu: parseInt(e.target.value, 10) || 1,
                  })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Default memory (MB)"
                value={dhis2.defaultMemoryMb}
                onChange={e =>
                  update('dhis2', {
                    defaultMemoryMb: parseInt(e.target.value, 10) || 1024,
                  })
                }
                inputProps={{ step: 1024 }}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                type="number"
                label="Default storage (GB)"
                value={dhis2.defaultStorageGb}
                onChange={e =>
                  update('dhis2', {
                    defaultStorageGb: parseInt(e.target.value, 10) || 20,
                  })
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12}>
              <Typography variant="subtitle2" color="textSecondary">
                PostgreSQL (leave host blank to install per-instance)
              </Typography>
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Shared Postgres host"
                value={dhis2.postgresHost}
                onChange={e => update('dhis2', { postgresHost: e.target.value })}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={6} md={2}>
              <TextField
                fullWidth
                type="number"
                label="Port"
                value={dhis2.postgresPort}
                onChange={e =>
                  update('dhis2', {
                    postgresPort: parseInt(e.target.value, 10) || 5432,
                  })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={6} md={4}>
              <TextField
                fullWidth
                label="Admin user"
                value={dhis2.postgresAdminUser}
                onChange={e =>
                  update('dhis2', { postgresAdminUser: e.target.value })
                }
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                type="password"
                label="Admin password"
                value={dhis2.postgresAdminPassword}
                onChange={e =>
                  update('dhis2', { postgresAdminPassword: e.target.value })
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12}>
              <Typography variant="subtitle2" color="textSecondary">
                Backups
              </Typography>
            </Grid>
            <Grid item xs={12} md={3}>
              <FormControlLabel
                control={
                  <Switch
                    checked={dhis2.backupEnabled}
                    onChange={e =>
                      update('dhis2', { backupEnabled: e.target.checked })
                    }
                  />
                }
                label="Enable backups"
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="Schedule (cron)"
                value={dhis2.backupSchedule}
                onChange={e =>
                  update('dhis2', { backupSchedule: e.target.value })
                }
                disabled={!dhis2.backupEnabled}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                type="number"
                label="Retention (days)"
                value={dhis2.backupRetentionDays}
                onChange={e =>
                  update('dhis2', {
                    backupRetentionDays: parseInt(e.target.value, 10) || 7,
                  })
                }
                disabled={!dhis2.backupEnabled}
                className={classes.field}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="Offsite bucket (optional)"
                value={dhis2.backupBucket ?? ''}
                onChange={e =>
                  update('dhis2', { backupBucket: e.target.value })
                }
                disabled={!dhis2.backupEnabled}
                helperText="s3://bucket/path"
                className={classes.field}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Box className={classes.actions}>
        <Button
          variant="contained"
          color="primary"
          startIcon={<SaveIcon />}
          onClick={handleSave}
        >
          Save Settings
        </Button>
        <Button
          variant="outlined"
          startIcon={<RestoreIcon />}
          onClick={handleReset}
        >
          Reset to defaults
        </Button>
      </Box>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
      />
    </Box>
  );
};
