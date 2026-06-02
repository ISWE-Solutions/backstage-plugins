import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid, MenuItem, TextField, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { DHIS2Instance } from '../types';
import { settingsService } from '../services/settingsService';

export const DEFAULT_PG_PORT = 5432;

export interface EditDraft {
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
  /** SSH private-key path used to reach the PVE host for `pct exec`. */
  sshKeyPath: string;
}

export interface ProxyFilesState {
  loading: boolean;
  error: string | null;
  upstreamPath: string;
  upstreamContent: string;
  upstreamExists: boolean;
  sitePath: string;
  siteContent: string;
  siteExists: boolean;
  saving: boolean;
}

export interface EditInstanceDialogProps {
  open: boolean;
  instance: DHIS2Instance | null;
  draft: EditDraft | null;
  versions: string[];
  proxyFilesState: ProxyFilesState;
  onClose: () => void;
  onDraftChange: (draft: EditDraft) => void;
  onProxyFilesChange: (state: ProxyFilesState) => void;
  onReloadProxyFiles: () => void;
  onSaveProxyFiles: () => void;
  onSave: () => void;
}

export const EditInstanceDialog = ({
  open,
  instance,
  draft,
  versions,
  proxyFilesState,
  onClose,
  onDraftChange,
  onProxyFilesChange,
  onReloadProxyFiles,
  onSaveProxyFiles,
  onSave,
}: EditInstanceDialogProps) => {
  if (!draft) {
    return (
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Update Instance {instance?.name ?? 'instance'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary">
            Loading update form…
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
    );
  }

  const updateDraft = (patch: Partial<EditDraft>) => onDraftChange({ ...draft, ...patch });
  const s = settingsService.load();
  const remoteDbHost = (draft.dbHost || s.dhis2.postgresHost || '').trim();
  const willDropDb =
    remoteDbHost.length > 0 &&
    !['localhost', '127.0.0.1', '::1', 'postgres'].includes(remoteDbHost);
  const fmt = (v?: string | number) =>
    v === undefined || v === null || v === '' ? '(unset)' : String(v);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Update Instance {instance?.name ?? 'instance'}</DialogTitle>
      <DialogContent>
        <Grid container spacing={2}>
          {/* ---------- Instance identity ---------- */}
          <Grid item xs={12}>
            <Typography variant="subtitle2">Instance</Typography>
            <Typography variant="caption" color="textSecondary">
              Display name shown across Backstage and the DHIS2 version
              label tracked in the registry.
            </Typography>
          </Grid>
          <Grid item xs={12} sm={7}>
            <TextField
              label="Name"
              fullWidth
              value={draft.name}
              onChange={e => updateDraft({ name: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={5}>
            <TextField
              label="DHIS2 version"
              select
              fullWidth
              value={draft.version}
              onChange={e => updateDraft({ version: e.target.value })}
              helperText="Changing the version triggers an upgrade on save"
            >
              {(versions.length > 0 ? versions : [draft.version]).map(v => (
                <MenuItem key={v} value={v}>
                  {v}
                </MenuItem>
              ))}
            </TextField>
          </Grid>

          {/* ---------- LXC resources ---------- */}
          <Grid item xs={12}>
            <Typography variant="subtitle2" style={{ marginTop: 8 }}>
              LXC resources
            </Typography>
            <Typography variant="caption" color="textSecondary">
              Applied to the Proxmox container on save. Storage can only
              grow — Proxmox does not support shrinking rootfs.
            </Typography>
          </Grid>
          <Grid item xs={4}>
            <TextField
              label="vCPU"
              type="number"
              fullWidth
              value={draft.cpu}
              onChange={e => updateDraft({ cpu: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              label="Memory (MB)"
              type="number"
              fullWidth
              value={draft.memoryMb}
              onChange={e =>
                updateDraft({ memoryMb: Math.max(512, Number(e.target.value) || 512) })
              }
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              label="Storage (GB)"
              type="number"
              fullWidth
              value={draft.storageGb}
              onChange={e => updateDraft({ storageGb: Math.max(5, Number(e.target.value) || 5) })}
            />
          </Grid>

          {/* ---------- Database ---------- */}
          <Grid item xs={12}>
            <Typography variant="subtitle2" style={{ marginTop: 8 }}>
              Database
            </Typography>
            <Typography variant="caption" color="textSecondary">
              Connection details for this instance's PostgreSQL database.
              Rendered into dhis.conf on save and used as the source for
              database transfers.
            </Typography>
          </Grid>
          <Grid item xs={12} sm={8}>
            <TextField
              label="DB host"
              fullWidth
              value={draft.dbHost}
              onChange={e => updateDraft({ dbHost: e.target.value })}
              placeholder="db.example.org"
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="DB port"
              type="number"
              fullWidth
              value={draft.dbPort}
              onChange={e => updateDraft({ dbPort: Number(e.target.value) || DEFAULT_PG_PORT })}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="DB name"
              fullWidth
              value={draft.dbName}
              onChange={e => updateDraft({ dbName: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="DB user"
              fullWidth
              value={draft.dbUser}
              onChange={e => updateDraft({ dbUser: e.target.value })}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="DB password"
              type="password"
              fullWidth
              value={draft.dbPassword}
              onChange={e => updateDraft({ dbPassword: e.target.value })}
              helperText="Stored on the orchestrator and used for database transfers."
            />
          </Grid>

          {/* ---------- Container access (SSH) ---------- */}
          <Grid item xs={12}>
            <Typography variant="subtitle2" style={{ marginTop: 8 }}>
              Container access (SSH)
            </Typography>
            <Typography variant="caption" color="textSecondary">
              SSH private-key path on the Backstage host used to reach
              the PVE node and run <code>pct exec</code> inside this
              instance's LXC. Defaults to the global Settings ▸ Reverse
              Proxy key; override here if a different key is authorized
              on this node.
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="SSH key path"
              fullWidth
              value={draft.sshKeyPath}
              onChange={e => updateDraft({ sshKeyPath: e.target.value })}
              placeholder={s.proxy.sshKeyPath || '/home/backstage/.ssh/id_ed25519'}
              helperText="Absolute path to the SSH private key on the Backstage host."
              InputProps={{
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 13,
                },
              }}
            />
          </Grid>
          {(() => {
            const remoteDbHostForDisplay = (draft.dbHost || s.dhis2.postgresHost || '').trim();
            const displayDropDb =
              remoteDbHostForDisplay.length > 0 &&
              !['localhost', '127.0.0.1', '::1', 'postgres'].includes(remoteDbHostForDisplay);
            return (
              <>
                <Grid item xs={12}>
                  <Typography variant="subtitle2" style={{ marginTop: 16 }}>
                    Decommission settings
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Read-only — sourced from the plugin Settings tab and this instance's record. The Delete button uses these values to tear down the LXC (Proxmox API), the central Nginx vhost (SSH to the proxy host), and optionally the shared-PostgreSQL database. Update them under Settings ▸ Proxmox / Reverse Proxy / Database Configurations.
                  </Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="Proxmox API URL" fullWidth value={fmt(s.proxmox.apiUrl)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="Proxmox node" fullWidth value={fmt(instance?.node)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <TextField label="VMID" fullWidth value={fmt(instance?.vmid)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={8}>
                  <TextField label="Domain / path" fullWidth value={fmt(instance?.domain)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="Proxy host (SSH)" fullWidth value={fmt(s.proxy.host)} InputProps={{ readOnly: true }} helperText="SSH target running the central Nginx" />
                </Grid>
                <Grid item xs={6} sm={3}>
                  <TextField label="SSH port" fullWidth value={fmt(s.proxy.sshPort)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={6} sm={3}>
                  <TextField label="SSH user" fullWidth value={fmt(s.proxy.sshUser)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12}>
                  <TextField label="SSH key path" fullWidth value={fmt(s.proxy.sshKeyPath)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={7}>
                  <TextField label="Nginx upstream dir" fullWidth value={fmt(s.proxy.nginxConfigPath)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12} sm={5}>
                  <TextField label="Nginx reload command" fullWidth value={fmt(s.proxy.nginxReloadCommand)} InputProps={{ readOnly: true }} />
                </Grid>
                <Grid item xs={12}>
                  <Typography variant="caption" color="textSecondary">
                    {displayDropDb
                      ? `Database will be dropped on shared host "${remoteDbHostForDisplay}" using the admin role below.`
                      : 'Database is local to the LXC and will be destroyed with it (no separate drop step).'}
                  </Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="DB admin user" fullWidth value={fmt(s.dhis2.postgresAdminUser)} InputProps={{ readOnly: true }} disabled={!displayDropDb} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="DB admin password" type="password" fullWidth value={s.dhis2.postgresAdminPassword ? '••••••••' : '(unset)'} InputProps={{ readOnly: true }} disabled={!displayDropDb} />
                </Grid>
              </>
            );
          })()}
          <Grid item xs={12}>
            <Typography variant="subtitle2" style={{ marginTop: 16 }}>
              Proxy configuration files
            </Typography>
            <Typography variant="caption" color="textSecondary">
              These are the per-instance nginx files on the central proxy host: the upstream snippet ({proxyFilesState.upstreamPath || '<computed at load>'}) and the vhost / dhis.conf ({proxyFilesState.sitePath || '<computed at load>'}). Saving writes both files via SSH and runs {' '}<code>nginx -t &amp;&amp; systemctl reload nginx</code>.
            </Typography>
          </Grid>
          {proxyFilesState.error && (
            <Grid item xs={12}>
              <Alert severity="error">{proxyFilesState.error}</Alert>
            </Grid>
          )}
          <Grid item xs={12}>
            <TextField
              label={`Upstream (${proxyFilesState.upstreamExists ? 'editing' : 'new file'})`}
              fullWidth
              multiline
              minRows={6}
              maxRows={20}
              value={proxyFilesState.upstreamContent}
              onChange={e =>
                onProxyFilesChange({
                  ...proxyFilesState,
                  upstreamContent: e.target.value,
                })
              }
              disabled={proxyFilesState.loading || proxyFilesState.saving}
              helperText={proxyFilesState.upstreamPath}
              InputProps={{
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                },
              }}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label={`dhis.conf / vhost (${proxyFilesState.siteExists ? 'editing' : 'new file'})`}
              fullWidth
              multiline
              minRows={8}
              maxRows={30}
              value={proxyFilesState.siteContent}
              onChange={e =>
                onProxyFilesChange({
                  ...proxyFilesState,
                  siteContent: e.target.value,
                })
              }
              disabled={proxyFilesState.loading || proxyFilesState.saving}
              helperText={proxyFilesState.sitePath}
              InputProps={{
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                },
              }}
            />
          </Grid>
          <Grid item xs={12}>
            <Box display="flex" style={{ gap: 8 }}>
              <Button
                variant="outlined"
                disabled={proxyFilesState.loading || proxyFilesState.saving}
                onClick={onReloadProxyFiles}
              >
                {proxyFilesState.loading ? 'Loading…' : 'Reload from server'}
              </Button>
              <Button
                variant="contained"
                color="primary"
                disabled={proxyFilesState.loading || proxyFilesState.saving}
                onClick={onSaveProxyFiles}
              >
                {proxyFilesState.saving ? 'Saving…' : 'Save & reload nginx'}
              </Button>
            </Box>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={onSave} color="primary" variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};
