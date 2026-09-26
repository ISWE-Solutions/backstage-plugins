import { Box, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { SyncRun } from '../../services/ipamService';

const STALE_MINUTES = 30;

/** Latest discovery sync run, as reported by ipam_sync.py */
export const SyncStatusCard = ({
  runs,
  now = new Date(),
}: {
  runs?: SyncRun[];
  now?: Date;
}) => {
  if (!runs) return <Typography variant="body2">Loading…</Typography>;
  const last = runs.find(r => !r.dryRun);
  if (!last) {
    return (
      <Alert severity="info">
        No sync run reported yet. The discovery sync reports here once
        BACKSTAGE_URL and BACKSTAGE_SYNC_TOKEN are set on the phpIPAM host.
      </Alert>
    );
  }
  const minutes = Math.round(
    (now.getTime() - new Date(last.finishedAt).getTime()) / 60_000,
  );
  const sources = Object.entries(last.sources)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  return (
    <Box>
      {minutes > STALE_MINUTES && (
        <Alert severity="warning">
          The last sync finished {minutes} minutes ago — it normally runs every
          15 minutes.
        </Alert>
      )}
      {last.errors.length > 0 && (
        <Alert severity="error">
          {last.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </Alert>
      )}
      <Typography variant="body2">
        Last run {new Date(last.finishedAt).toLocaleString()} ({minutes} min
        ago, {last.durationSeconds}s)
      </Typography>
      <Typography variant="body2">Observed: {sources || 'nothing'}</Typography>
      <Typography variant="body2">
        Changes: {last.created} created, {last.updated} updated, {last.skipped}{' '}
        outside known subnets
      </Typography>
    </Box>
  );
};
