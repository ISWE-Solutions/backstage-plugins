import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  MenuItem,
  TextField,
  Typography,
} from '@material-ui/core';
import {
  ProxmoxResources,
  ProxmoxStorage,
} from '@internal/plugin-proxmox-common';
import { bytes, percent } from './format';
import { StatusChip, UsageBar } from './parts';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';
import { Sparkline, growthPerDay, useStorageGrowth, UsagePoint } from './rates';

const COLUMNS_KEY = 'proxmox.storage.columns.v2';
const COLUMNS: ColumnDefinition[] = [
  { id: 'storage', label: 'Storage', defaultWidth: 160 },
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'type', label: 'Type', defaultWidth: 110 },
  { id: 'content', label: 'Content', defaultWidth: 160 },
  { id: 'protection', label: 'Protection', defaultWidth: 170 },
  { id: 'shared', label: 'Shared', defaultWidth: 90 },
  { id: 'status', label: 'Status', defaultWidth: 100 },
  { id: 'used', label: 'Used', defaultWidth: 100, defaultVisible: false },
  { id: 'total', label: 'Capacity', defaultWidth: 100, defaultVisible: false },
  { id: 'avail', label: 'Available', defaultWidth: 100, defaultVisible: false },
  { id: 'usage', label: 'Usage', defaultWidth: 200 },
  { id: 'growth', label: 'Growth', defaultWidth: 180 },
];

// Storage types whose disks support snapshots in Proxmox.
const SNAPSHOT_TYPES = new Set(['zfspool', 'zfs', 'rbd', 'lvmthin', 'btrfs']);
const NEAR_FULL = 0.9;

const protectionLabels = (s: ProxmoxStorage): string[] => {
  const out: string[] = [];
  if (/backup/i.test(s.content)) out.push('Backups');
  if (SNAPSHOT_TYPES.has(s.type.toLowerCase())) out.push('Snapshots');
  return out;
};

const growthLabel = (points: UsagePoint[]): string => {
  if (points.length < 2) return 'measuring…';
  const perDay = growthPerDay(points);
  if (Math.abs(perDay) < 1024 * 1024) return 'steady';
  return `${perDay > 0 ? '+' : '−'}${bytes(Math.abs(perDay))}/day`;
};

const csvEscape = (v: string) =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export const StorageTab = ({ data }: { data: ProxmoxResources }) => {
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);
  const growth = useStorageGrowth(data.storage, data.generatedAt);
  const [q, setQ] = useState('');
  const [nodeFilter, setNodeFilter] = useState('all');
  const [nearFullOnly, setNearFullOnly] = useState(false);

  const nodeOptions = useMemo(
    () => Array.from(new Set(data.storage.map(s => s.node))).sort(),
    [data.storage],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.storage.filter(s => {
      if (nodeFilter !== 'all' && s.node !== nodeFilter) return false;
      if (nearFullOnly && !(s.total && s.usage >= NEAR_FULL)) return false;
      if (!needle) return true;
      return (
        s.storage.toLowerCase().includes(needle) ||
        s.node.toLowerCase().includes(needle) ||
        s.type.toLowerCase().includes(needle) ||
        s.content.toLowerCase().includes(needle)
      );
    });
  }, [data.storage, q, nodeFilter, nearFullOnly]);

  // Cluster-wide capacity, de-duplicating shared pools seen on every node.
  const summary = useMemo(() => {
    const seen = new Set<string>();
    let capacity = 0;
    let used = 0;
    for (const s of data.storage) {
      const key = s.shared ? s.storage : s.id;
      if (seen.has(key)) continue;
      seen.add(key);
      capacity += s.total;
      used += s.used;
    }
    const nearFull = data.storage.filter(
      s => s.total && s.usage >= NEAR_FULL,
    ).length;
    return {
      pools: seen.size,
      capacity,
      used,
      free: capacity - used,
      nearFull,
    };
  }, [data.storage]);

  const cellTitle = (id: string, s: ProxmoxStorage): string => {
    switch (id) {
      case 'storage':
        return s.storage;
      case 'node':
        return s.node;
      case 'type':
        return s.type;
      case 'content':
        return s.content ?? '';
      case 'protection': {
        const labels = protectionLabels(s);
        return labels.length ? labels.join(', ') : 'none';
      }
      case 'shared':
        return s.shared ? 'shared' : '';
      case 'status':
        return s.active ? 'online' : 'offline';
      case 'used':
        return bytes(s.used);
      case 'total':
        return bytes(s.total);
      case 'avail':
        return bytes(s.avail);
      case 'usage':
        return s.total ? `${(s.usage * 100).toFixed(0)}%` : '';
      case 'growth':
        return growthLabel(growth.get(s.id) ?? []);
      default:
        return '';
    }
  };

  const renderCell = (id: string, s: ProxmoxStorage) => {
    switch (id) {
      case 'content':
        return s.content || '—';
      case 'protection': {
        const labels = protectionLabels(s);
        return labels.length ? (
          <>
            {labels.map(l => (
              <Chip
                key={l}
                size="small"
                label={l}
                style={{ marginRight: 4, height: 18 }}
              />
            ))}
          </>
        ) : (
          '—'
        );
      }
      case 'shared':
        return s.shared ? (
          <Chip size="small" label="shared" style={{ height: 18 }} />
        ) : (
          '—'
        );
      case 'status':
        return <StatusChip status={s.active ? 'online' : 'offline'} />;
      case 'used':
        return bytes(s.used);
      case 'total':
        return bytes(s.total);
      case 'avail':
        return bytes(s.avail);
      case 'usage':
        return s.total ? (
          <UsageBar used={s.used} total={s.total} frac={s.usage} />
        ) : (
          '—'
        );
      case 'growth': {
        const points = growth.get(s.id) ?? [];
        const perDay = points.length >= 2 ? growthPerDay(points) : 0;
        return (
          <Box>
            <Sparkline
              values={points.map(p => p.used)}
              color={perDay > 0 ? '#c62828' : '#2e7d32'}
              width={120}
              height={22}
            />
            <Typography variant="caption" style={{ fontFamily: 'monospace' }}>
              {growthLabel(points)}
            </Typography>
          </Box>
        );
      }
      default:
        return cellTitle(id, s) || '-';
    }
  };

  const exportCsv = () => {
    const cols = columns.visibleColumns;
    const lines = [
      cols.map(c => c.label).join(','),
      ...rows.map(s => cols.map(c => csvEscape(cellTitle(c.id, s))).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([lines], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxmox-storage-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Box>
      <Box
        display="flex"
        alignItems="center"
        style={{ gap: 12 }}
        mb={2}
        flexWrap="wrap"
      >
        <TextField
          size="small"
          variant="outlined"
          label="Search storage, node, type, content"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          variant="outlined"
          label="Node"
          value={nodeFilter}
          onChange={e => setNodeFilter(e.target.value)}
          style={{ minWidth: 130 }}
        >
          <MenuItem value="all">All nodes</MenuItem>
          {nodeOptions.map(n => (
            <MenuItem key={n} value={n}>
              {n}
            </MenuItem>
          ))}
        </TextField>
        <Box flexGrow={1} />
        <Button
          variant="outlined"
          size="small"
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          Export CSV
        </Button>
        <ColumnsMenuButton
          id="proxmox-storage"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>

      {/* Capacity summary; the near-full chip filters the table */}
      <Box display="flex" style={{ gap: 8 }} mb={2} flexWrap="wrap">
        <Chip label={`Pools: ${summary.pools}`} />
        <Chip label={`Capacity: ${bytes(summary.capacity)}`} />
        <Chip
          label={`Used: ${bytes(summary.used)} (${
            summary.capacity ? percent(summary.used / summary.capacity) : '0%'
          })`}
        />
        <Chip label={`Free: ${bytes(summary.free)}`} />
        <Chip
          label={`Near full: ${summary.nearFull}`}
          onClick={() => setNearFullOnly(v => !v)}
          color={nearFullOnly ? 'secondary' : 'default'}
          variant={summary.nearFull ? 'default' : 'outlined'}
        />
      </Box>

      <ManagedTable
        settings={columns}
        rows={rows}
        rowKey={s => s.id}
        renderCell={renderCell}
        cellTitle={cellTitle}
        align={{ used: 'right', total: 'right', avail: 'right' }}
      />
    </Box>
  );
};
