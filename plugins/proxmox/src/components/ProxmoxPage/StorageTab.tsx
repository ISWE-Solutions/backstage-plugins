import { Box, Chip } from '@material-ui/core';
import {
  ProxmoxResources,
  ProxmoxStorage,
} from '@internal/plugin-proxmox-common';
import { StatusChip, UsageBar } from './parts';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';

const COLUMNS_KEY = 'proxmox.storage.columns.v1';
const COLUMNS: ColumnDefinition[] = [
  { id: 'storage', label: 'Storage', defaultWidth: 160 },
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'type', label: 'Type', defaultWidth: 110 },
  { id: 'content', label: 'Content', defaultWidth: 160 },
  { id: 'shared', label: 'Shared', defaultWidth: 90 },
  { id: 'status', label: 'Status', defaultWidth: 100 },
  { id: 'usage', label: 'Usage', defaultWidth: 200 },
];

export const StorageTab = ({ data }: { data: ProxmoxResources }) => {
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);

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
      case 'shared':
        return s.shared ? 'shared' : '';
      case 'status':
        return s.active ? 'online' : 'offline';
      case 'usage':
        return s.total ? `${(s.usage * 100).toFixed(0)}%` : '';
      default:
        return '';
    }
  };

  const renderCell = (id: string, s: ProxmoxStorage) => {
    switch (id) {
      case 'content':
        return s.content || '—';
      case 'shared':
        return s.shared ? (
          <Chip size="small" label="shared" style={{ height: 18 }} />
        ) : (
          '—'
        );
      case 'status':
        return <StatusChip status={s.active ? 'online' : 'offline'} />;
      case 'usage':
        return s.total ? (
          <UsageBar used={s.used} total={s.total} frac={s.usage} />
        ) : (
          '—'
        );
      default:
        return cellTitle(id, s) || '-';
    }
  };

  return (
    <Box>
      <Box display="flex" mb={2}>
        <Box flexGrow={1} />
        <ColumnsMenuButton
          id="proxmox-storage"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>
      <ManagedTable
        settings={columns}
        rows={data.storage}
        rowKey={s => s.id}
        renderCell={renderCell}
        cellTitle={cellTitle}
      />
    </Box>
  );
};
