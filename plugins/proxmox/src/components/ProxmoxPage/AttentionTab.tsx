import { Box, Chip } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import {
  AttentionItem,
  CATEGORY_INFO,
} from '@iswesolutions/plugin-proxmox-common';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from './ManagedTable';

const COLUMNS_KEY = 'proxmox.attention.columns.v1';
const COLUMNS: ColumnDefinition[] = [
  { id: 'severity', label: 'Severity', defaultWidth: 110 },
  { id: 'issue', label: 'Issue', defaultWidth: 160 },
  { id: 'subject', label: 'Subject', defaultWidth: 220 },
  { id: 'node', label: 'Node', defaultWidth: 110 },
  { id: 'detail', label: 'Detail', defaultWidth: 320 },
];

type Row = AttentionItem & { _key: string };

export const AttentionTab = ({ items }: { items: AttentionItem[] }) => {
  const columns = useColumnSettings(COLUMNS_KEY, COLUMNS);

  if (items.length === 0) {
    return <Alert severity="success">Nothing needs attention.</Alert>;
  }

  const rows: Row[] = items.map((it, i) => ({
    ...it,
    _key: `${it.category}-${it.subject}-${i}`,
  }));

  const cellTitle = (id: string, it: Row): string => {
    switch (id) {
      case 'severity':
        return it.severity;
      case 'issue':
        return CATEGORY_INFO[it.category].label;
      case 'subject':
        return it.subject;
      case 'node':
        return it.node;
      case 'detail':
        return it.detail;
      default:
        return '';
    }
  };

  const renderCell = (id: string, it: Row) => {
    if (id === 'severity') {
      return (
        <Chip
          size="small"
          label={it.severity}
          style={{
            backgroundColor: it.severity === 'high' ? '#c62828' : '#ed6c02',
            color: '#fff',
            height: 20,
          }}
        />
      );
    }
    return cellTitle(id, it) || '-';
  };

  return (
    <Box>
      <Box display="flex" mb={2}>
        <Box flexGrow={1} />
        <ColumnsMenuButton
          id="proxmox-attention"
          columns={COLUMNS}
          settings={columns}
        />
      </Box>
      <ManagedTable
        settings={columns}
        rows={rows}
        rowKey={r => r._key}
        renderCell={renderCell}
        cellTitle={cellTitle}
      />
    </Box>
  );
};
