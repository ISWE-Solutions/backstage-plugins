/** Human-readable formatting helpers for the Proxmox dashboard. */

export const bytes = (n: number): string => {
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  const v = n / 1024 ** i;
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export const percent = (frac: number): string => `${(frac * 100).toFixed(0)}%`;

export const uptime = (seconds: number): string => {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/** MUI palette colour name for a 0..1 usage fraction */
export const usageColor = (frac: number): 'primary' | 'secondary' =>
  frac >= 0.9 ? 'secondary' : 'primary';
