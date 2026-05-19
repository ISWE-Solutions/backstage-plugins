import { useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  makeStyles,
} from '@material-ui/core';
import WarningIcon from '@material-ui/icons/Warning';
import { DHIS2Instance, RestoreJob, RestoreSource } from '../types';
import {
  restoreService,
  validateRestoreSource,
} from '../services/restoreService';
import { RestoreSourcePicker } from './RestoreSourcePicker';

const useStyles = makeStyles(theme => ({
  warning: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    backgroundColor: theme.palette.warning.light,
    color: theme.palette.warning.contrastText,
    borderRadius: 4,
    marginBottom: theme.spacing(2),
  },
  jobBox: {
    marginTop: theme.spacing(2),
    padding: theme.spacing(1.5),
    backgroundColor: theme.palette.background.default,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: '0.85rem',
  },
}));

export interface RestoreInstanceDialogProps {
  open: boolean;
  instance: DHIS2Instance | null;
  nodes: { node: string }[];
  onClose: () => void;
}

/**
 * Dialog that drives a restore against an *existing* instance.
 *
 * The flow is destructive: backend will stop Tomcat, drop & recreate the
 * DB, apply the dump, then start Tomcat again. The dialog surfaces a
 * clear warning before the user confirms, and shows the returned
 * `RestoreJob` so the user can follow progress in the Logs tab.
 */
export const RestoreInstanceDialog = (props: RestoreInstanceDialogProps) => {
  const classes = useStyles();
  const { open, instance, nodes, onClose } = props;

  const [source, setSource] = useState<RestoreSource | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<RestoreJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSource(undefined);
    setSubmitting(false);
    setJob(null);
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!instance) return;
    const validation = validateRestoreSource(source);
    if (validation || !source) {
      setError(validation ?? 'Pick a backup source.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await restoreService.restoreExistingInstance(
        instance.id,
        source,
      );
      setJob(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const validationError = validateRestoreSource(source);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Restore from backup
        {instance ? ` — ${instance.name}` : ''}
      </DialogTitle>
      <DialogContent dividers>
        <Box className={classes.warning}>
          <WarningIcon />
          <Box>
            <Typography variant="subtitle2">
              This action is destructive
            </Typography>
            <Typography variant="body2">
              Tomcat will be stopped, the <code>{instance?.database.name}</code>{' '}
              database will be dropped and recreated, the dump will be applied,
              and then Tomcat will be restarted. The current data on this
              instance will be lost.
            </Typography>
          </Box>
        </Box>

        {job ? (
          <Box>
            <Typography variant="body2">
              Restore job submitted. Follow progress in the Logs tab.
            </Typography>
            <Box className={classes.jobBox}>
              <div>jobId: {job.jobId}</div>
              <div>status: {job.status}</div>
              <div>startedAt: {job.startedAt}</div>
            </Box>
          </Box>
        ) : (
          <RestoreSourcePicker
            value={source}
            onChange={setSource}
            nodes={nodes}
          />
        )}

        {error && (
          <Typography variant="caption" color="error">
            {error}
          </Typography>
        )}
        {!job && validationError && source && (
          <Typography variant="caption" color="error">
            {validationError}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          {job ? 'Close' : 'Cancel'}
        </Button>
        {!job && (
          <Button
            onClick={handleSubmit}
            color="secondary"
            variant="contained"
            disabled={submitting || Boolean(validationError) || !source}
            startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          >
            Restore
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
