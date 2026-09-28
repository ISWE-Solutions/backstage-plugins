import {
  Box,
  Card,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@material-ui/core';
import { ProxmoxResources } from '@internal/plugin-proxmox-common';
import { StatusChip, UsageBar } from './parts';

export const StorageTab = ({ data }: { data: ProxmoxResources }) => (
  <Box>
    <TableContainer component={Card}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Storage</TableCell>
            <TableCell>Node</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Content</TableCell>
            <TableCell>Shared</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Usage</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.storage.map(s => (
            <TableRow key={s.id} hover>
              <TableCell>{s.storage}</TableCell>
              <TableCell>{s.node}</TableCell>
              <TableCell>{s.type}</TableCell>
              <TableCell>{s.content || '—'}</TableCell>
              <TableCell>
                {s.shared ? (
                  <Chip size="small" label="shared" style={{ height: 18 }} />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                <StatusChip status={s.active ? 'online' : 'offline'} />
              </TableCell>
              <TableCell>
                {s.total ? (
                  <UsageBar used={s.used} total={s.total} frac={s.usage} />
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  </Box>
);
