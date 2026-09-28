import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ProxmoxCluster,
  proxmoxClusterManagePermission,
} from '@internal/plugin-proxmox-common';
import { ClusterInput, proxmoxApiRef } from '../../services/proxmoxService';

interface Props {
  clusters: ProxmoxCluster[];
  onChanged: () => void;
}

const EMPTY: ClusterInput = { name: '', url: '', token: '', verifyTls: false };

export const SettingsTab = ({ clusters, onChanged }: Props) => {
  const api = useApi(proxmoxApiRef);
  const { allowed: canManage } = usePermission({
    permission: proxmoxClusterManagePermission,
  });

  const [dialog, setDialog] = useState<{
    open: boolean;
    editId?: string;
    form: ClusterInput;
  }>({ open: false, form: EMPTY });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  const openAdd = () =>
    setDialog({ open: true, form: { ...EMPTY, verifyTls: false } });
  const openEdit = (c: ProxmoxCluster) =>
    setDialog({
      open: true,
      editId: c.id,
      // token intentionally blank — leave empty to keep the stored one
      form: { name: c.name, url: c.url, token: '', verifyTls: c.verifyTls },
    });
  const close = () => setDialog(d => ({ ...d, open: false }));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (dialog.editId) {
        await api.updateCluster(dialog.editId, dialog.form);
      } else {
        await api.addCluster(dialog.form);
      }
      close();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: ProxmoxCluster) => {
    setError(undefined);
    try {
      await api.deleteCluster(c.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const test = async (c: ProxmoxCluster) => {
    setTestResults(r => ({ ...r, [c.id]: { ok: false, message: 'Testing…' } }));
    try {
      const res = await api.testCluster({ id: c.id });
      setTestResults(r => ({ ...r, [c.id]: res }));
    } catch (e) {
      setTestResults(r => ({
        ...r,
        [c.id]: {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  return (
    <Box>
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        mb={2}
      >
        <Typography variant="h6">Clusters</Typography>
        <Tooltip
          title={
            canManage ? '' : 'Requires the proxmox.cluster.manage permission'
          }
        >
          <span>
            <Button
              variant="contained"
              color="primary"
              disabled={!canManage}
              onClick={openAdd}
            >
              Add cluster
            </Button>
          </span>
        </Tooltip>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Card>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>URL</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Verify TLS</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {clusters.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="textSecondary">
                    No clusters configured. Add one, or define{' '}
                    <code>proxmox.clusters</code> in app-config.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {clusters.map(c => {
              const r = testResults[c.id];
              return (
                <TableRow key={c.id} hover>
                  <TableCell>{c.name}</TableCell>
                  <TableCell style={{ fontFamily: 'monospace' }}>
                    {c.url}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={c.source === 'config' ? 'app-config' : 'UI'}
                    />
                  </TableCell>
                  <TableCell>{c.verifyTls ? 'yes' : 'no'}</TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => test(c)}>
                      Test
                    </Button>
                    {c.source === 'db' && (
                      <>
                        <Button
                          size="small"
                          disabled={!canManage}
                          onClick={() => openEdit(c)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          disabled={!canManage}
                          onClick={() => remove(c)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                    {r && (
                      <Typography
                        variant="caption"
                        component="div"
                        style={{ color: r.ok ? '#2e7d32' : '#c62828' }}
                      >
                        {r.ok ? '✓ ' : '✗ '}
                        {r.message}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Typography
        variant="caption"
        color="textSecondary"
        component="p"
        style={{ marginTop: 12 }}
      >
        Cluster API tokens are stored on the backend and never returned to the
        browser. app-config clusters are read-only here.
      </Typography>

      <Dialog open={dialog.open} onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>
          {dialog.editId ? 'Edit cluster' : 'Add cluster'}
        </DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="normal"
            label="Name"
            value={dialog.form.name}
            onChange={e =>
              setDialog(d => ({
                ...d,
                form: { ...d.form, name: e.target.value },
              }))
            }
          />
          <TextField
            fullWidth
            margin="normal"
            label="API URL"
            placeholder="https://10.20.30.10:8006"
            value={dialog.form.url}
            onChange={e =>
              setDialog(d => ({
                ...d,
                form: { ...d.form, url: e.target.value },
              }))
            }
          />
          <TextField
            fullWidth
            margin="normal"
            type="password"
            label="API token"
            placeholder="user@realm!tokenid=secret"
            helperText={
              dialog.editId
                ? 'Leave blank to keep the existing token'
                : 'Read-only token (e.g. PVEAuditor)'
            }
            value={dialog.form.token}
            onChange={e =>
              setDialog(d => ({
                ...d,
                form: { ...d.form, token: e.target.value },
              }))
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={dialog.form.verifyTls ?? false}
                onChange={e =>
                  setDialog(d => ({
                    ...d,
                    form: { ...d.form, verifyTls: e.target.checked },
                  }))
                }
              />
            }
            label="Verify TLS certificate"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="contained"
            color="primary"
            onClick={save}
            disabled={busy || !dialog.form.name || !dialog.form.url}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
