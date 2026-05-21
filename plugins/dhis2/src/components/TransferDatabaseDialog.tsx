import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  LinearProgress,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import {
  fetchApiRef,
  useApi,
  discoveryApiRef,
} from '@backstage/core-plugin-api';

import { DHIS2Instance } from '../types';
import {
  dhis2Service,
  TransferJobSnapshot,
} from '../services/dhis2Service';

const useStyles = makeStyles(theme => ({
  section: {
    marginTop: theme.spacing(2),
  },
  sectionTitle: {
    fontWeight: 600,
    marginBottom: theme.spacing(1),
  },
  logBox: {
    marginTop: theme.spacing(2),
    backgroundColor: theme.palette.type === 'dark' ? '#0b0b0b' : '#1e1e1e',
    color: '#e7e7e7',
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: 12,
    padding: theme.spacing(1.5),
    borderRadius: theme.shape.borderRadius,
    maxHeight: 280,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
}));

interface Endpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const DEFAULT_PG_PORT = 5432;

const blankEndpoint = (overrides: Partial<Endpoint> = {}): Endpoint => ({
  host: '',
  port: DEFAULT_PG_PORT,
  user: '',
  password: '',
  database: '',
  ...overrides,
});

export interface TransferDatabaseDialogProps {
  open: boolean;
  instance: DHIS2Instance | null;
  onClose: () => void;
  /** Called when a transfer finishes successfully. */
  onCompleted?: () => void;
}

export const TransferDatabaseDialog = ({
  open,
  instance,
  onClose,
  onCompleted,
}: TransferDatabaseDialogProps) => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const discoveryApi = useApi(discoveryApiRef);

  const [source, setSource] = useState<Endpoint>(blankEndpoint());
  const [target, setTarget] = useState<Endpoint>(blankEndpoint());
  const [showSrcPwd, setShowSrcPwd] = useState(false);
  const [showTgtPwd, setShowTgtPwd] = useState(false);

  const [createTargetDb, setCreateTargetDb] = useState(true);
  const [dropTargetIfExists, setDropTargetIfExists] = useState(false);
  const [noOwner, setNoOwner] = useState(true);
  const [noPrivileges, setNoPrivileges] = useState(true);
  const [clean, setClean] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [job, setJob] = useState<TransferJobSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Reset state whenever a new instance is opened.
  useEffect(() => {
    if (!open) return;
    setSource(
      blankEndpoint({
        user: instance?.database.user ?? '',
        database: instance?.database.name ?? '',
      }),
    );
    setTarget(
      blankEndpoint({
        database: instance?.database.name ?? '',
      }),
    );
    setShowSrcPwd(false);
    setShowTgtPwd(false);
    setCreateTargetDb(true);
    setDropTargetIfExists(false);
    setNoOwner(true);
    setNoPrivileges(true);
    setClean(false);
    setTesting(false);
    setTestResult(null);
    setJob(null);
    setSubmitting(false);
    setSubmitError(null);
  }, [open, instance]);

  // Poll the job snapshot every second while the transfer is running.
  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return undefined;
    }
    const interval = window.setInterval(async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('dhis2');
        const snap = await dhis2Service.getTransferJob(
          baseUrl,
          job.id,
          backstageFetch,
        );
        setJob(snap);
        if (snap.status === 'success') {
          onCompleted?.();
        }
      } catch (err) {
        // Surface but keep polling — the backend may just be busy.
        // eslint-disable-next-line no-console
        console.warn('Transfer poll failed', err);
      }
    }, 1000);
    pollRef.current = interval;
    return () => {
      window.clearInterval(interval);
      pollRef.current = null;
    };
  }, [job, discoveryApi, backstageFetch, onCompleted]);

  // Auto-scroll the log to the bottom as new lines arrive.
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [job?.lines.length]);

  const inProgress =
    submitting || job?.status === 'queued' || job?.status === 'running';

  const fieldErrors = useMemo(() => {
    const errs: string[] = [];
    const check = (label: string, ep: Endpoint) => {
      if (!ep.host.trim()) errs.push(`${label} host is required`);
      if (!Number.isInteger(ep.port) || ep.port <= 0 || ep.port > 65535)
        errs.push(`${label} port must be 1–65535`);
      if (!ep.user.trim()) errs.push(`${label} user is required`);
      if (!ep.password) errs.push(`${label} password is required`);
      if (!ep.database.trim()) errs.push(`${label} database is required`);
    };
    check('Source', source);
    check('Target', target);
    if (
      source.host.trim() === target.host.trim() &&
      source.port === target.port &&
      source.database.trim() === target.database.trim()
    ) {
      errs.push(
        'Source and target point at the same host:port and database — pick a different target.',
      );
    }
    return errs;
  }, [source, target]);

  const handleTestTarget = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const res = await dhis2Service.testDatabaseConnection(
        {
          host: target.host,
          port: target.port,
          user: target.user,
          password: target.password,
        },
        baseUrl,
        backstageFetch,
      );
      setTestResult({ ok: res.ok, message: res.message });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    if (!instance) return;
    if (fieldErrors.length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setJob(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startDatabaseTransfer(
        baseUrl,
        instance.id,
        {
          source: { ...source, host: source.host.trim(), user: source.user.trim(), database: source.database.trim() },
          target: { ...target, host: target.host.trim(), user: target.user.trim(), database: target.database.trim() },
          options: {
            createTargetDatabase: createTargetDb,
            dropTargetIfExists,
            noOwner,
            noPrivileges,
            clean,
          },
        },
        backstageFetch,
      );
      // Seed an empty snapshot so the polling effect kicks in.
      setJob({
        id: jobId,
        instanceId: instance.id,
        status: 'queued',
        startedAt: new Date().toISOString(),
        lines: ['Transfer queued…'],
        request: {
          source: {
            host: source.host,
            port: source.port,
            user: source.user,
            database: source.database,
          },
          target: {
            host: target.host,
            port: target.port,
            user: target.user,
            database: target.database,
          },
          options: {
            createTargetDatabase: createTargetDb,
            dropTargetIfExists,
            noOwner,
            noPrivileges,
            clean,
            maintenanceDatabase: 'postgres',
          },
        },
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderEndpoint = (
    label: string,
    ep: Endpoint,
    setEp: (next: Endpoint) => void,
    showPwd: boolean,
    setShowPwd: (v: boolean) => void,
  ) => (
    <Box className={classes.section}>
      <Typography variant="subtitle1" className={classes.sectionTitle}>
        {label}
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={8}>
          <TextField
            label="Host"
            fullWidth
            size="small"
            variant="outlined"
            value={ep.host}
            onChange={e => setEp({ ...ep, host: e.target.value })}
            disabled={inProgress}
            placeholder="db.example.org"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            label="Port"
            type="number"
            fullWidth
            size="small"
            variant="outlined"
            value={ep.port}
            onChange={e =>
              setEp({ ...ep, port: Number(e.target.value) || DEFAULT_PG_PORT })
            }
            disabled={inProgress}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            label="User"
            fullWidth
            size="small"
            variant="outlined"
            value={ep.user}
            onChange={e => setEp({ ...ep, user: e.target.value })}
            disabled={inProgress}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            label="Password"
            type={showPwd ? 'text' : 'password'}
            fullWidth
            size="small"
            variant="outlined"
            value={ep.password}
            onChange={e => setEp({ ...ep, password: e.target.value })}
            disabled={inProgress}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="Toggle password visibility"
                    onClick={() => setShowPwd(!showPwd)}
                    edge="end"
                    size="small"
                  >
                    {showPwd ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
        </Grid>
        <Grid item xs={12}>
          <TextField
            label="Database"
            fullWidth
            size="small"
            variant="outlined"
            value={ep.database}
            onChange={e => setEp({ ...ep, database: e.target.value })}
            disabled={inProgress}
          />
        </Grid>
      </Grid>
    </Box>
  );

  const finished = job?.status === 'success' || job?.status === 'failed';

  return (
    <Dialog open={open} onClose={inProgress ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Transfer database{instance ? ` — ${instance.name}` : ''}
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="info">
          Streams the source database via <code>pg_dump</code> directly into the
          target server via <code>psql</code>. Requires{' '}
          <code>postgresql-client</code> on the Backstage backend host and
          network reachability to both endpoints.
        </Alert>

        {renderEndpoint('Source (current instance database)', source, setSource, showSrcPwd, setShowSrcPwd)}
        {renderEndpoint('Target server', target, setTarget, showTgtPwd, setShowTgtPwd)}

        <Box className={classes.section} display="flex" alignItems="center" style={{ gap: 12 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={handleTestTarget}
            disabled={testing || inProgress || !target.host || !target.user || !target.password}
          >
            {testing ? <CircularProgress size={16} /> : 'Test target connection'}
          </Button>
          {testResult && (
            <Typography
              variant="body2"
              style={{ color: testResult.ok ? '#2e7d32' : '#c62828' }}
            >
              {testResult.message}
            </Typography>
          )}
        </Box>

        <Box className={classes.section}>
          <Typography variant="subtitle1" className={classes.sectionTitle}>
            Options
          </Typography>
          <Grid container>
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={createTargetDb}
                    onChange={(_, v) => setCreateTargetDb(v)}
                    disabled={inProgress}
                  />
                }
                label="Create target database if it does not exist"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={dropTargetIfExists}
                    onChange={(_, v) => setDropTargetIfExists(v)}
                    disabled={inProgress}
                  />
                }
                label="Drop target database first (destructive)"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={noOwner}
                    onChange={(_, v) => setNoOwner(v)}
                    disabled={inProgress}
                  />
                }
                label="Strip object ownership (--no-owner)"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={noPrivileges}
                    onChange={(_, v) => setNoPrivileges(v)}
                    disabled={inProgress}
                  />
                }
                label="Strip GRANT/REVOKE (--no-privileges)"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={clean}
                    onChange={(_, v) => setClean(v)}
                    disabled={inProgress}
                  />
                }
                label="Drop existing objects in target db (--clean --if-exists)"
              />
            </Grid>
          </Grid>
        </Box>

        {fieldErrors.length > 0 && !inProgress && !job && (
          <Alert severity="warning" style={{ marginTop: 16 }}>
            {fieldErrors.map(e => (
              <div key={e}>{e}</div>
            ))}
          </Alert>
        )}
        {submitError && (
          <Alert severity="error" style={{ marginTop: 16 }}>
            {submitError}
          </Alert>
        )}

        {job && (
          <Box className={classes.section}>
            <Typography variant="subtitle1" className={classes.sectionTitle}>
              Progress — {job.status}
            </Typography>
            {!finished && <LinearProgress />}
            {job.error && (
              <Alert severity="error" style={{ marginTop: 8 }}>
                {job.error}
              </Alert>
            )}
            {job.status === 'success' && (
              <Alert severity="success" style={{ marginTop: 8 }}>
                Database transferred to {job.request.target.user}@
                {job.request.target.host}:{job.request.target.port}/
                {job.request.target.database}.
              </Alert>
            )}
            <Box className={classes.logBox}>
              {job.lines.length === 0 ? '…' : job.lines.join('\n')}
              <div ref={logEndRef} />
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={inProgress}>
          {finished ? 'Close' : 'Cancel'}
        </Button>
        <Button
          color="primary"
          variant="contained"
          onClick={handleSubmit}
          disabled={inProgress || fieldErrors.length > 0 || !instance}
        >
          {inProgress ? (
            <CircularProgress size={20} color="inherit" />
          ) : finished ? (
            'Run again'
          ) : (
            'Start transfer'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
