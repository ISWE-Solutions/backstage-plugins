import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { DHIS2Instance } from '../types';
import { settingsService } from '../services/settingsService';

export interface DeleteInstanceDialogProps {
  open: boolean;
  instance: DHIS2Instance | null;
  onClose: () => void;
  onConfirm: () => void;
}

export const DeleteInstanceDialog = ({
  open,
  instance,
  onClose,
  onConfirm,
}: DeleteInstanceDialogProps) => {
  const settings = settingsService.load();
  const remoteDbHost = (instance?.database.host || settings.dhis2.postgresHost || '').trim();
  const willDropDb =
    remoteDbHost.length > 0 &&
    !['localhost', '127.0.0.1', '::1', 'postgres'].includes(remoteDbHost);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete Instance {instance?.name ?? 'instance'}</DialogTitle>
      <DialogContent>
        <Alert severity="error" variant="filled" style={{ marginBottom: 16 }}>
          This will permanently delete the instance and cannot be undone.
        </Alert>
        <Typography variant="body2" paragraph>
          The decommission workflow stops and destroys the LXC, removes the
          central Nginx vhost, and drops the database when a shared PostgreSQL
          host is configured.
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <Typography variant="caption" color="textSecondary">
              Proxmox node
            </Typography>
            <Typography variant="body2">{instance?.node ?? '—'}</Typography>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Typography variant="caption" color="textSecondary">
              VMID
            </Typography>
            <Typography variant="body2">{instance?.vmid ?? '—'}</Typography>
          </Grid>
          <Grid item xs={12}>
            <Typography variant="caption" color="textSecondary">
              Domain
            </Typography>
            <Typography variant="body2">{instance?.domain ?? '—'}</Typography>
          </Grid>
          <Grid item xs={12}>
            <Typography variant="caption" color="textSecondary">
              Proxy host
            </Typography>
            <Typography variant="body2">{settings.proxy.host || '—'}</Typography>
          </Grid>
          <Grid item xs={12}>
            <Typography variant="caption" color="textSecondary">
              Database action
            </Typography>
            <Typography variant="body2">
              {willDropDb
                ? `Database will be dropped on shared host "${remoteDbHost}".`
                : 'Database is local to the LXC and will be removed with it.'}
            </Typography>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="secondary" variant="contained" onClick={onConfirm}>
          Delete Instance
        </Button>
      </DialogActions>
    </Dialog>
  );
};