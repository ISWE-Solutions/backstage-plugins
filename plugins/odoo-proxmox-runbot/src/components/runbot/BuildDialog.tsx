import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import {
  RunbotBuild,
  RunbotBuildLog,
} from '@iswesolutions/plugin-odoo-runbot-common';
import { runbotApiRef } from '../../api/runbotApi';
import {
  RESULT_COLORS,
  duration,
  githubCommitUrl,
  shortSha,
  stateLabel,
} from './common';

const useStyles = makeStyles(theme => ({
  log: {
    fontFamily: 'monospace',
    fontSize: '0.78rem',
    whiteSpace: 'pre-wrap',
    background: theme.palette.background.default,
    padding: theme.spacing(1),
    maxHeight: 480,
    overflow: 'auto',
    borderRadius: theme.shape.borderRadius,
  },
}));

const LEVEL_COLORS: Record<string, string> = {
  ERROR: '#c62828',
  CRITICAL: '#b71c1c',
  WARNING: '#ef6c00',
  RUNBOT: '#1565c0',
};

/**
 * One build: state, commits, the trigger's step, and its log (live while it
 * runs). Rebuild and kill need the odoo-runbot.build.manage permission.
 */
export const BuildDialog = ({
  buildId,
  onClose,
  onOpenBuild,
}: {
  buildId: number | undefined;
  onClose: () => void;
  onOpenBuild: (id: number) => void;
}) => {
  const classes = useStyles();
  const api = useApi(runbotApiRef);
  const [build, setBuild] = useState<RunbotBuild>();
  const [logs, setLogs] = useState<RunbotBuildLog[]>([]);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [error, setError] = useState<string>();
  const lastId = useRef(0);

  const load = useCallback(async () => {
    if (!buildId) return;
    try {
      const b = await api.getBuild(buildId);
      setBuild(b);
      const more = await api.getLogs(buildId, { after: lastId.current });
      if (more.length) {
        lastId.current = more[more.length - 1].id;
        setLogs(prev => [...prev, ...more]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, buildId]);

  useEffect(() => {
    setBuild(undefined);
    setLogs([]);
    setError(undefined);
    lastId.current = 0;
    if (!buildId) return undefined;
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [buildId, load]);

  const act = async (fn: () => Promise<{ buildId: number }>) => {
    try {
      const r = await fn();
      if (r.buildId !== buildId) onOpenBuild(r.buildId);
      else load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = problemsOnly
    ? logs.filter(l => ['ERROR', 'CRITICAL', 'WARNING'].includes(l.level))
    : logs;
  const state = build ? stateLabel(build) : '';
  const step = build?.params.steps[0];

  return (
    <Dialog open={Boolean(buildId)} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Build #{buildId}
        {build && (
          <Chip
            size="small"
            label={state}
            style={{
              marginLeft: 12,
              backgroundColor: RESULT_COLORS[state],
              color: '#fff',
            }}
          />
        )}
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" style={{ marginBottom: 8 }}>
            {error}
          </Alert>
        )}
        {build && (
          <>
            <Table size="small">
              <TableBody>
                <TableRow>
                  <TableCell>Trigger</TableCell>
                  <TableCell>
                    {build.triggerName} · Odoo {build.params.version}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Builder</TableCell>
                  <TableCell>
                    {build.host ?? 'not started'}
                    {build.started && ` · ${duration(build)}`}
                  </TableCell>
                </TableRow>
                {build.errorSummary && (
                  <TableRow>
                    <TableCell>First error</TableCell>
                    <TableCell style={{ color: RESULT_COLORS.ko }}>
                      {build.errorSummary}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell>Commits</TableCell>
                  <TableCell>
                    {build.params.commits.map(c => (
                      <Box key={c.repoId}>
                        <Link
                          href={githubCommitUrl(c.slug, c.sha)}
                          target="_blank"
                          rel="noopener"
                        >
                          {c.repoName}@{shortSha(c.sha)}
                        </Link>
                        {c.tested ? ' (tested)' : ''}
                      </Box>
                    ))}
                  </TableCell>
                </TableRow>
                {step && (
                  <TableRow>
                    <TableCell>Step</TableCell>
                    <TableCell>
                      Install {step.modules.join(', ') || '*'}
                      {step.excludeModules.length
                        ? `, except ${step.excludeModules.join(', ')}`
                        : ''}
                      {step.testTags
                        ? `; tests ${step.testTags}`
                        : '; all tests'}
                      {step.demo ? '; with demo data' : '; without demo data'};
                      timeout {step.timeout} s
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <Box
              display="flex"
              alignItems="center"
              justifyContent="space-between"
              mt={2}
            >
              <Typography variant="subtitle2">
                Log ({logs.length} lines
                {build.localState !== 'done' ? ', live' : ''})
              </Typography>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={problemsOnly}
                    onChange={e => setProblemsOnly(e.target.checked)}
                  />
                }
                label="Errors and warnings only"
              />
            </Box>
            <Box className={classes.log}>
              {shown.length === 0 && (
                <Typography variant="caption">No log lines yet.</Typography>
              )}
              {shown.map(l => (
                <div key={l.id} style={{ color: LEVEL_COLORS[l.level] }}>
                  {l.level !== 'INFO' && <strong>{l.level} </strong>}
                  {l.logger !== 'runbot' && l.logger !== 'stdout' && (
                    <span style={{ opacity: 0.6 }}>{l.logger}: </span>
                  )}
                  {l.message}
                </div>
              ))}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {build && build.localState !== 'done' && (
          <Button onClick={() => act(() => api.kill(build.id))}>Kill</Button>
        )}
        {build && build.localState === 'done' && (
          <Button onClick={() => act(() => api.rebuild(build.id))}>
            Rebuild
          </Button>
        )}
        <Button onClick={onClose} color="primary">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
