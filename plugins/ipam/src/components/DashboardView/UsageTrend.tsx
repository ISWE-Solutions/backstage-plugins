import { Box, Typography } from '@material-ui/core';
import { useTheme } from '@material-ui/core/styles';
import { UsagePoint } from '../../services/ipamService';

const PALETTE = [
  '#1565c0',
  '#2e7d32',
  '#ef6c00',
  '#6a1b9a',
  '#00838f',
  '#c62828',
];

/**
 * Percentage used per subnet over time, as a small SVG line chart (one line
 * per subnet, 0–100% scale, 80% and 90% guide lines).
 */
export const UsageTrend = ({ points }: { points: UsagePoint[] }) => {
  const theme = useTheme();
  const dates = [...new Set(points.map(p => p.date))].sort();
  const subnets = [...new Set(points.map(p => p.cidr))].sort();
  if (dates.length < 2) {
    return (
      <Typography variant="body2" color="textSecondary">
        Usage is recorded once a day; the trend appears after the second day
        {dates.length === 1 ? ` (first snapshot: ${dates[0]})` : ''}.
      </Typography>
    );
  }
  const W = 640;
  const H = 200;
  const pad = { l: 36, r: 12, t: 10, b: 24 };
  const x = (i: number) =>
    pad.l + (i * (W - pad.l - pad.r)) / (dates.length - 1);
  const y = (pct: number) => pad.t + ((100 - pct) * (H - pad.t - pad.b)) / 100;
  const lines = subnets.map((cidr, k) => {
    const pts = dates
      .map((d, i) => {
        const p = points.find(q => q.cidr === cidr && q.date === d);
        return p && p.max ? `${x(i)},${y((p.used / p.max) * 100)}` : null;
      })
      .filter(Boolean);
    return { cidr, color: PALETTE[k % PALETTE.length], d: pts.join(' ') };
  });
  const grid = theme.palette.divider;
  const text = theme.palette.text.secondary;
  return (
    <Box>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Subnet usage over time"
      >
        {[0, 50, 80, 90, 100].map(v => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke={grid}
              strokeDasharray={v === 80 || v === 90 ? '4 3' : undefined}
            />
            <text
              x={pad.l - 6}
              y={y(v) + 4}
              fontSize="10"
              textAnchor="end"
              fill={text}
            >
              {v}%
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} fontSize="10" fill={text}>
          {dates[0]}
        </text>
        <text
          x={W - pad.r}
          y={H - 6}
          fontSize="10"
          textAnchor="end"
          fill={text}
        >
          {dates[dates.length - 1]}
        </text>
        {lines.map(l => (
          <polyline
            key={l.cidr}
            points={l.d}
            fill="none"
            stroke={l.color}
            strokeWidth={2}
          >
            <title>{l.cidr}</title>
          </polyline>
        ))}
      </svg>
      <Box display="flex" flexWrap="wrap" style={{ gap: 16 }}>
        {lines.map(l => (
          <Typography key={l.cidr} variant="caption">
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 3,
                background: l.color,
                marginRight: 4,
                verticalAlign: 'middle',
              }}
            />
            {l.cidr}
          </Typography>
        ))}
      </Box>
    </Box>
  );
};
