import { Box, Chip, LinearProgress, Typography } from '@material-ui/core';
import { bytes, percent, usageColor } from './format';

/** A small coloured status chip for node/guest status. */
export const StatusChip = ({ status }: { status: string }) => {
  const ok = status === 'running' || status === 'online';
  const warn = status === 'paused';
  return (
    <Chip
      size="small"
      label={status}
      style={{
        backgroundColor: ok ? '#2e7d32' : warn ? '#ed6c02' : '#9e9e9e',
        color: '#fff',
        height: 20,
      }}
    />
  );
};

/** A labelled usage bar: "used / total (nn%)". */
export const UsageBar = ({
  used,
  total,
  frac,
  width = 160,
}: {
  used: number;
  total: number;
  frac: number;
  width?: number;
}) => (
  <Box width={width}>
    <Box display="flex" justifyContent="space-between">
      <Typography variant="caption">{percent(frac)}</Typography>
      <Typography variant="caption" color="textSecondary">
        {bytes(used)} / {bytes(total)}
      </Typography>
    </Box>
    <LinearProgress
      variant="determinate"
      value={Math.min(frac * 100, 100)}
      color={usageColor(frac)}
      style={{ height: 8, borderRadius: 4 }}
    />
  </Box>
);
