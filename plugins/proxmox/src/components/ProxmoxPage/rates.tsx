import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@material-ui/core';
import {
  ProxmoxGuest,
  ProxmoxStorage,
} from '@iswesolutions/plugin-proxmox-common';
import { bytes } from './format';

/** One derived sample: instantaneous CPU/mem plus I/O rates (bytes/sec). */
export interface RateSample {
  t: number;
  cpu: number; // fraction 0..1
  mem: number; // fraction 0..1
  netIn: number; // bytes/sec
  netOut: number;
  diskRead: number;
  diskWrite: number;
}

const CAP = 40; // keep the last ~40 polls per guest

type Counters = {
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  t: number;
};

/**
 * Accumulates per-guest rate history from successive `/resources` snapshots.
 * The Proxmox API only exposes cumulative byte counters, so rates are computed
 * as deltas between polls. History lives in the browser for the session (it
 * grows while the page is open and resets on reload) — enough for live graphs.
 */
export function useGuestRates(
  guests: ProxmoxGuest[],
  generatedAt: string,
): Map<string, RateSample[]> {
  const histories = useRef(new Map<string, RateSample[]>());
  const prev = useRef(new Map<string, Counters>());
  const [, bump] = useState(0);

  useEffect(() => {
    const t = new Date(generatedAt).getTime() || Date.now();
    const liveIds = new Set(guests.map(g => g.id));
    for (const g of guests) {
      const p = prev.current.get(g.id);
      if (p && t > p.t) {
        const dt = (t - p.t) / 1000;
        const rate = (cur: number, was: number) =>
          Math.max(0, (cur - was) / dt); // clamp counter resets
        const arr = histories.current.get(g.id) ?? [];
        arr.push({
          t,
          cpu: g.status === 'running' ? g.cpu : 0,
          mem: g.maxmem ? g.mem / g.maxmem : 0,
          netIn: rate(g.netin, p.netin),
          netOut: rate(g.netout, p.netout),
          diskRead: rate(g.diskread, p.diskread),
          diskWrite: rate(g.diskwrite, p.diskwrite),
        });
        if (arr.length > CAP) arr.shift();
        histories.current.set(g.id, arr);
      }
      prev.current.set(g.id, {
        netin: g.netin,
        netout: g.netout,
        diskread: g.diskread,
        diskwrite: g.diskwrite,
        t,
      });
    }
    // forget guests that disappeared
    for (const id of [...prev.current.keys()]) {
      if (!liveIds.has(id)) {
        prev.current.delete(id);
        histories.current.delete(id);
      }
    }
    bump(v => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedAt]);

  return histories.current;
}

/** One point of storage usage over time. */
export interface UsagePoint {
  t: number;
  used: number;
}

/**
 * Rolling history of storage `used` bytes per pool, for growth trends. Same
 * session-scoped, delta-free approach as the guest rates: history builds while
 * the page is open and resets on reload.
 */
export function useStorageGrowth(
  storage: ProxmoxStorage[],
  generatedAt: string,
): Map<string, UsagePoint[]> {
  const histories = useRef(new Map<string, UsagePoint[]>());
  const [, bump] = useState(0);

  useEffect(() => {
    const t = new Date(generatedAt).getTime() || Date.now();
    const liveIds = new Set(storage.map(s => s.id));
    for (const s of storage) {
      const arr = histories.current.get(s.id) ?? [];
      const last = arr[arr.length - 1];
      if (!last || t > last.t) {
        arr.push({ t, used: s.used });
        if (arr.length > CAP) arr.shift();
        histories.current.set(s.id, arr);
      }
    }
    for (const id of [...histories.current.keys()]) {
      if (!liveIds.has(id)) histories.current.delete(id);
    }
    bump(v => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedAt]);

  return histories.current;
}

/** Projected growth in bytes/day from the observed window (0 if <2 points). */
export function growthPerDay(points: UsagePoint[]): number {
  if (points.length < 2) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  const dtSec = (last.t - first.t) / 1000;
  if (dtSec <= 0) return 0;
  return ((last.used - first.used) / dtSec) * 86_400;
}

/** Minimal inline-SVG sparkline (no external chart library — CSP-safe). */
export const Sparkline = ({
  values,
  color = '#1976d2',
  width = 140,
  height = 30,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) => {
  if (values.length < 2) {
    return (
      <Typography variant="caption" color="textSecondary">
        measuring…
      </Typography>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
};

/** A labelled sparkline: title, current value, and the trend line. */
export const RateGraph = ({
  title,
  values,
  latest,
  color,
}: {
  title: string;
  values: number[];
  latest: string;
  color?: string;
}) => (
  <Box>
    <Box display="flex" justifyContent="space-between">
      <Typography variant="caption" color="textSecondary">
        {title}
      </Typography>
      <Typography variant="caption" style={{ fontFamily: 'monospace' }}>
        {latest}
      </Typography>
    </Box>
    <Sparkline values={values} color={color} />
  </Box>
);

export const bytesPerSec = (n: number) => `${bytes(n)}/s`;
