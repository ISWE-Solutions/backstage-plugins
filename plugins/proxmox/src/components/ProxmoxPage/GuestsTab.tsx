import { useMemo, useState } from 'react';
import {
  Box,
  Card,
  Chip,
  Link,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@material-ui/core';
import {
  ProxmoxGuest,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { percent, uptime } from './format';
import { StatusChip, UsageBar } from './parts';

type Filter = 'all' | 'running' | 'stopped';

export const GuestsTab = ({ data }: { data: ProxmoxResources }) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

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
      </Box>
      <TableContainer component={Card}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>VMID</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Node</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>CPU</TableCell>
              <TableCell>Memory</TableCell>
              <TableCell>Uptime</TableCell>
              <TableCell>Tags</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(g => (
              <TableRow key={g.id} hover>
                <TableCell>{g.vmid}</TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell>{g.type === 'lxc' ? 'LXC' : 'VM'}</TableCell>
                <TableCell>{g.node}</TableCell>
                <TableCell>
                  <StatusChip status={g.status} />
                </TableCell>
                <TableCell>
                  {g.status === 'running' ? percent(g.cpu) : '—'}
                </TableCell>
                <TableCell>
                  {g.status === 'running' && g.maxmem ? (
                    <UsageBar
                      used={g.mem}
                      total={g.maxmem}
                      frac={g.mem / g.maxmem}
                      width={140}
                    />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>{uptime(g.uptime)}</TableCell>
                <TableCell>
                  {g.tags.map(t => (
                    <Chip
                      key={t}
                      size="small"
                      label={t}
                      style={{ marginRight: 4, height: 18 }}
                    />
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
