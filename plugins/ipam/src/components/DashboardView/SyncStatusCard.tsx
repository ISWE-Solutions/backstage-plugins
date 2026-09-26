import { Box, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { SyncRun } from '../../services/ipamService';

const STALE_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ago = (iso: string, now: Date) =>
  Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);

/**
 * Discovery sync health: the last successful run of ipam_sync.py and the
 * records it added or changed, plus 24-hour totals. Runs are newest first.
 */
export const SyncStatusCard = ({
  runs,
  now = new Date(),
}: {
  runs?: SyncRun[];
  now?: Date;
}) => {
  if (!runs) return <Typography variant="body2">Loading…</Typography>;
  const real = runs.filter(r => !r.dryRun);
  if (!real.length) {
    return (
      <Alert severity="info">
        No sync run reported yet. The discovery sync reports here once
        BACKSTAGE_URL and BACKSTAGE_SYNC_TOKEN are set on the phpIPAM host.
      </Alert>
    );
  }
  const latest = real[0];
  const lastSuccess = real.find(r => r.errors.length === 0);
  const day = real.filter(
    r => now.getTime() - new Date(r.finishedAt).getTime() <= DAY_MS,
  );
  const added24 = day.reduce((n, r) => n + r.created, 0);
  const changed24 = day.reduce((n, r) => n + r.updated, 0);
  const quiet = ago(latest.finishedAt, now);

  return (
    <Box>
      {quiet > STALE_MINUTES && (
        <Alert severity="warning">
          No run reported for {quiet} minutes — the sync normally runs every 15
          minutes.
        </Alert>
      )}
      {latest.errors.length > 0 && (
        <Alert severity="error">
          Latest run ({new Date(latest.finishedAt).toLocaleString()}) had
          errors:
          {latest.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </Alert>
      )}
      {lastSuccess ? (
        <Box mt={1}>
          <Typography variant="subtitle2">Last successful run</Typography>
          <Typography variant="body2">
            {new Date(lastSuccess.finishedAt).toLocaleString()} (
            {ago(lastSuccess.finishedAt, now)} min ago,{' '}
            {lastSuccess.durationSeconds}s)
          </Typography>
          <Typography variant="body2">
            Records added: <strong>{lastSuccess.created}</strong> · changed:{' '}
            <strong>{lastSuccess.updated}</strong>
            {lastSuccess.skipped
              ? ` · ${lastSuccess.skipped} outside known subnets`
              : ''}
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Observed:{' '}
            {Object.entries(lastSuccess.sources)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ') || 'nothing'}
          </Typography>
        </Box>
      ) : (
        <Alert severity="error">
          No successful run in the last {real.length} reported.
        </Alert>
      )}
      <Box mt={1}>
        <Typography variant="subtitle2">Last 24 hours</Typography>
        <Typography variant="body2">
          {day.length} run{day.length === 1 ? '' : 's'} · records added:{' '}
          <strong>{added24}</strong> · changed: <strong>{changed24}</strong>
        </Typography>
      </Box>
    </Box>
  );
};
