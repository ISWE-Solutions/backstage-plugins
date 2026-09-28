import { useMemo, useState } from 'react';
import { Box, Chip, Link, MenuItem, TextField } from '@material-ui/core';
import {
  ProxmoxGuest,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { percent, uptime } from './format';
import { StatusChip, UsageBar } from './parts';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';

type Filter = 'all' | 'running' | 'stopped';

const COLUMNS_KEY = 'proxmox.guests.columns.v1';
const COLUMNS: ColumnDefinition[] = [
  { id: 'vmid', label: 'VMID', defaultWidth: 90 },
  { id: 'name', label: 'Name', defaultWidth: 200 },
  { id: 'type', label: 'Type', defaultWidth: 80 },
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'status', label: 'Status', defaultWidth: 110 },
  { id: 'cpu', label: 'CPU', defaultWidth: 90 },
  { id: 'memory', label: 'Memory', defaultWidth: 180 },
  { id: 'uptime', label: 'Uptime', defaultWidth: 110 },
  { id: 'tags', label: 'Tags', defaultWidth: 160 },
];

export const GuestsTab = ({ data }: { data: ProxmoxResources }) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.guests.filter((g: ProxmoxGuest) => {
      if (filter === 'running' && g.status !== 'running') return false;
      if (filter === 'stopped' && (g.status !== 'stopped' || g.template))
        return false;
      if (!needle) return true;
      return (
        g.name.toLowerCase().includes(needle) ||
        String(g.vmid).includes(needle) ||
        g.node.toLowerCase().includes(needle) ||
        g.tags.some(t => t.toLowerCase().includes(needle))
      );
    });
  }, [data.guests, q, filter]);

  const cellTitle = (id: string, g: ProxmoxGuest): string => {
    switch (id) {
      case 'vmid':
        return String(g.vmid);
      case 'name':
        return g.template ? `${g.name} (template)` : g.name;
      case 'type':
        return g.type === 'lxc' ? 'LXC' : 'VM';
      case 'node':
        return g.node;
      case 'status':
        return g.status;
      case 'cpu':
        return g.status === 'running' ? percent(g.cpu) : '';
      case 'memory':
        return g.status === 'running' && g.maxmem
          ? `${percent(g.mem / g.maxmem)}`
          : '';
      case 'uptime':
        return uptime(g.uptime);
      case 'tags':
        return g.tags.join(', ');
      default:
        return '';
    }
  };

  const renderCell = (id: string, g: ProxmoxGuest) => {
    switch (id) {
      case 'name':
        return (
          <>
            {g.uiUrl ? (
              <Link href={g.uiUrl} target="_blank" rel="noopener">
                {g.name}
              </Link>
            ) : (
              g.name
            )}
            {g.template && (
              <Chip
                size="small"
                label="template"
                style={{ marginLeft: 6, height: 18 }}
              />
            )}
          </>
        );
      case 'type':
        return g.type === 'lxc' ? 'LXC' : 'VM';
      case 'status':
        return <StatusChip status={g.status} />;
      case 'cpu':
        return g.status === 'running' ? percent(g.cpu) : '—';
      case 'memory':
        return g.status === 'running' && g.maxmem ? (
          <UsageBar
            used={g.mem}
            total={g.maxmem}
            frac={g.mem / g.maxmem}
            width={140}
          />
        ) : (
          '—'
        );
      case 'uptime':
        return uptime(g.uptime);
      case 'tags':
        return (
          <>
            {g.tags.map(t => (
              <Chip
                key={t}
                size="small"
                label={t}
                style={{ marginRight: 4, height: 18 }}
              />
            ))}
          </>
        );
      default:
        return cellTitle(id, g) || '-';
    }
  };

  return (
    <Box>
      <Box display="flex" style={{ gap: 16 }} mb={2} flexWrap="wrap">
        <TextField
          size="small"
          variant="outlined"
          label="Search name, VMID, node, tag"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          variant="outlined"
          label="Show"
          value={filter}
          onChange={e => setFilter(e.target.value as Filter)}
          style={{ minWidth: 140 }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="running">Running</MenuItem>
          <MenuItem value="stopped">Stopped</MenuItem>
        </TextField>
        <Box flexGrow={1} />
        <ColumnsMenuButton
          id="proxmox-guests"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>
      <ManagedTable
        settings={columns}
        rows={rows}
        rowKey={g => g.id}
        renderCell={renderCell}
        cellTitle={cellTitle}
        align={{ vmid: 'right' }}
      />
    </Box>
  );
};
