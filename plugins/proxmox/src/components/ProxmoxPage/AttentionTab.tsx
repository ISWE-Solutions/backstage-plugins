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
import { Alert } from '@material-ui/lab';
import { AttentionItem, CATEGORY_INFO } from '@internal/plugin-proxmox-common';

export const AttentionTab = ({ items }: { items: AttentionItem[] }) => {
  if (items.length === 0) {
    return <Alert severity="success">Nothing needs attention.</Alert>;
  }
  return (
    <Box>
      <TableContainer component={Card}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Severity</TableCell>
              <TableCell>Issue</TableCell>
              <TableCell>Subject</TableCell>
              <TableCell>Node</TableCell>
              <TableCell>Detail</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((it, i) => (
              <TableRow key={`${it.category}-${it.subject}-${i}`} hover>
                <TableCell>
                  <Chip
                    size="small"
                    label={it.severity}
                    style={{
                      backgroundColor:
                        it.severity === 'high' ? '#c62828' : '#ed6c02',
                      color: '#fff',
                      height: 20,
                    }}
                  />
                </TableCell>
                <TableCell>{CATEGORY_INFO[it.category].label}</TableCell>
                <TableCell>{it.subject}</TableCell>
                <TableCell>{it.node}</TableCell>
                <TableCell>{it.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
