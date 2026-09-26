import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  MenuItem,
  Chip,
  Typography,
  Button,
  InputAdornment,
  LinearProgress,
  Menu,
  Checkbox,
  ListItemIcon,
  ListItemText,
  Divider,
  Tooltip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import SearchIcon from '@material-ui/icons/Search';
import AddIcon from '@material-ui/icons/Add';
import ViewColumnIcon from '@material-ui/icons/ViewColumn';
import { IPAddress, IPStatus, IPFilter, Subnet, VLAN } from '../../types';
import { useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { ipamAddressCreatePermission } from '@internal/plugin-ipam-common';
import { ipamApiRef } from '../../services/ipamService';
import { AddIPDialog } from '../AddIPDialog/AddIPDialog';
import {
  ColumnDefinition,
  MIN_COLUMN_WIDTH,
  useColumnSettings,
} from './useColumnSettings';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(3),
  },
  filterSection: {
    marginBottom: theme.spacing(3),
    display: 'flex',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  },
  filterField: {
    minWidth: 200,
  },
  addButton: {
    marginLeft: 'auto',
  },
  tableContainer: {
    maxHeight: 600,
  },
  table: {
    tableLayout: 'fixed',
  },
  headerCell: {
    position: 'relative',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none',
  },
  bodyCell: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  resizeHandle: {
    border: 0,
    padding: 0,
    background: 'transparent',
    position: 'absolute',
    top: 0,
    right: 0,
    width: 8,
    height: '100%',
    cursor: 'col-resize',
    zIndex: 1,
    '&:hover, &:active, &:focus-visible': {
      borderRight: `2px solid ${theme.palette.primary.main}`,
      outline: 'none',
    },
  },
  mono: {
    fontFamily: 'monospace',
  },
  statusChip: {
    minWidth: 90,
  },
  headerRow: {
    backgroundColor: theme.palette.grey[100],
  },
}));

const COLUMNS_STORAGE_KEY = 'ipam.ipListView.columns.v1';

const COLUMNS: ColumnDefinition[] = [
  { id: 'ipAddress', label: 'IP Address', defaultWidth: 140 },
  { id: 'hostname', label: 'Hostname', defaultWidth: 180 },
  { id: 'status', label: 'Status', defaultWidth: 120 },
  { id: 'subnet', label: 'Subnet', defaultWidth: 150 },
  { id: 'vlan', label: 'VLAN', defaultWidth: 140, defaultVisible: false },
  {
    id: 'assignedTo',
    label: 'Assigned To',
    defaultWidth: 150,
    defaultVisible: false,
  },
  { id: 'source', label: 'Source', defaultWidth: 130 },
  { id: 'macAddress', label: 'MAC Address', defaultWidth: 160 },
  { id: 'description', label: 'Description', defaultWidth: 220 },
  { id: 'lastSeen', label: 'Last Seen', defaultWidth: 180 },
];

const getStatusColor = (status: IPStatus) => {
  switch (status) {
    case IPStatus.ALLOCATED:
      return 'primary';
    case IPStatus.RESERVED:
      return 'secondary';
    case IPStatus.OFFLINE:
      return 'error';
    case IPStatus.DHCP:
      return 'default';
    default:
      return 'default';
  }
};

export const IPListView = () => {
  const classes = useStyles();
  const ipamService = useApi(ipamApiRef);
  const { allowed: canCreate } = usePermission({
    permission: ipamAddressCreatePermission,
  });
  const [ipAddresses, setIPAddresses] = useState<IPAddress[]>([]);
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [vlans, setVLANs] = useState<VLAN[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<IPFilter>({});
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [columnsMenuAnchor, setColumnsMenuAnchor] =
    useState<HTMLElement | null>(null);
  const columns = useColumnSettings(COLUMNS_STORAGE_KEY, COLUMNS);
  // width shown while a column is being dragged; saved on mouse up
  const [dragging, setDragging] = useState<{ id: string; width: number }>();
  const dragStart = useRef<{ x: number; width: number }>();

  const startResize = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const width = columns.widthOf(id);
    dragStart.current = { x: event.clientX, width };
    setDragging({ id, width });

    const onMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      const next = Math.max(
        MIN_COLUMN_WIDTH,
        dragStart.current.width + e.clientX - dragStart.current.x,
      );
      setDragging({ id, width: next });
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragStart.current) {
        columns.setWidth(
          id,
          dragStart.current.width + e.clientX - dragStart.current.x,
        );
      }
      dragStart.current = undefined;
      setDragging(undefined);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const widthOf = (id: string) =>
    dragging?.id === id ? dragging.width : columns.widthOf(id);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [ipData, subnetData, vlanData] = await Promise.all([
        ipamService.getIPAddresses(filter),
        ipamService.getSubnets(),
        ipamService.getVLANs(),
      ]);
      setIPAddresses(ipData.addresses);
      setSubnets(subnetData.subnets);
      setVLANs(vlanData.vlans);
    } catch (error) {
      console.error('Failed to fetch IP data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [filter]);

  const handleFilterChange = (field: keyof IPFilter, value: any) => {
    setFilter(prev => ({
      ...prev,
      [field]: value || undefined,
    }));
  };

  const handleAddIP = async (
    ip: Omit<IPAddress, 'id' | 'createdAt' | 'updatedAt'>,
  ) => {
    try {
      await ipamService.addIPAddress(ip);
      setAddDialogOpen(false);
      fetchData();
    } catch (error) {
      console.error('Failed to add IP address:', error);
    }
  };

  const getSubnetDisplay = (subnetId: string) => {
    const subnet = subnets.find(s => s.id === subnetId);
    return subnet ? `${subnet.network}/${subnet.cidr}` : subnetId;
  };

  const getVLANDisplay = (vlanId?: string) => {
    if (!vlanId) return '-';
    const vlan = vlans.find(v => v.id === vlanId);
    return vlan ? `VLAN ${vlan.vlanId} (${vlan.name})` : vlanId;
  };

  const renderCell = (columnId: string, ip: IPAddress): React.ReactNode => {
    switch (columnId) {
      case 'ipAddress':
        return <span className={classes.mono}>{ip.ipAddress}</span>;
      case 'hostname':
        return ip.hostname || '-';
      case 'status':
        return (
          <Chip
            label={ip.status}
            size="small"
            color={getStatusColor(ip.status) as any}
            className={classes.statusChip}
          />
        );
      case 'subnet':
        return (
          <span className={classes.mono}>{getSubnetDisplay(ip.subnetId)}</span>
        );
      case 'vlan':
        return getVLANDisplay(ip.vlanId);
      case 'assignedTo':
        return ip.assignedTo || '-';
      case 'source':
        return ip.source || '-';
      case 'macAddress':
        return <span className={classes.mono}>{ip.macAddress || '-'}</span>;
      case 'description':
        return ip.description || '-';
      case 'lastSeen':
        return ip.lastSeen ? new Date(ip.lastSeen).toLocaleString() : '-';
      default:
        return null;
    }
  };

  /** Plain text of a cell, for the tooltip shown when it is truncated */
  const cellTitle = (columnId: string, ip: IPAddress) => {
    const value = renderCell(columnId, ip);
    if (typeof value === 'string') return value;
    switch (columnId) {
      case 'ipAddress':
        return ip.ipAddress;
      case 'subnet':
        return getSubnetDisplay(ip.subnetId);
      case 'macAddress':
        return ip.macAddress || '';
      default:
        return '';
    }
  };

  if (loading) {
    return <LinearProgress />;
  }

  return (
    <Box className={classes.root}>
      <Box className={classes.filterSection}>
        <TextField
          className={classes.filterField}
          label="Search"
          variant="outlined"
          size="small"
          placeholder="IP, hostname, or description..."
          value={filter.search || ''}
          onChange={e => handleFilterChange('search', e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />

        <TextField
          className={classes.filterField}
          select
          label="Subnet"
          variant="outlined"
          size="small"
          value={filter.subnetId || ''}
          onChange={e => handleFilterChange('subnetId', e.target.value)}
        >
          <MenuItem value="">All Subnets</MenuItem>
          {subnets.map(subnet => (
            <MenuItem key={subnet.id} value={subnet.id}>
              {subnet.network}/{subnet.cidr} - {subnet.description}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          className={classes.filterField}
          select
          label="Status"
          variant="outlined"
          size="small"
          value={filter.status || ''}
          onChange={e =>
            handleFilterChange('status', e.target.value as IPStatus)
          }
        >
          <MenuItem value="">All Statuses</MenuItem>
          <MenuItem value={IPStatus.ALLOCATED}>Used</MenuItem>
          <MenuItem value={IPStatus.RESERVED}>Reserved</MenuItem>
          <MenuItem value={IPStatus.OFFLINE}>Offline</MenuItem>
          <MenuItem value={IPStatus.DHCP}>DHCP</MenuItem>
        </TextField>

        <TextField
          className={classes.filterField}
          select
          label="VLAN"
          variant="outlined"
          size="small"
          value={filter.vlanId || ''}
          onChange={e => handleFilterChange('vlanId', e.target.value)}
        >
          <MenuItem value="">All VLANs</MenuItem>
          {vlans.map(vlan => (
            <MenuItem key={vlan.id} value={vlan.id}>
              VLAN {vlan.vlanId} - {vlan.name}
            </MenuItem>
          ))}
        </TextField>

        <Button
          className={classes.addButton}
          variant="outlined"
          startIcon={<ViewColumnIcon />}
          onClick={e => setColumnsMenuAnchor(e.currentTarget)}
          aria-controls="ipam-columns-menu"
          aria-haspopup="true"
        >
          Columns
        </Button>
        <Menu
          id="ipam-columns-menu"
          anchorEl={columnsMenuAnchor}
          keepMounted
          open={Boolean(columnsMenuAnchor)}
          onClose={() => setColumnsMenuAnchor(null)}
        >
          {COLUMNS.map(column => {
            const visible = columns.isVisible(column.id);
            const lastVisible = visible && columns.visibleColumns.length === 1;
            return (
              <MenuItem
                key={column.id}
                dense
                disabled={lastVisible}
                onClick={() => columns.toggleColumn(column.id)}
              >
                <ListItemIcon>
                  <Checkbox
                    edge="start"
                    size="small"
                    checked={visible}
                    tabIndex={-1}
                    disableRipple
                    color="primary"
                  />
                </ListItemIcon>
                <ListItemText primary={column.label} />
              </MenuItem>
            );
          })}
          <Divider />
          <MenuItem
            dense
            onClick={() => {
              columns.resetAll();
              setColumnsMenuAnchor(null);
            }}
          >
            <ListItemText
              primary="Reset columns"
              secondary="Default columns and widths"
            />
          </MenuItem>
        </Menu>

        <Tooltip
          title={
            canCreate
              ? ''
              : 'You need the IPAM editor role (phpIPAM Admins or Operators group in SSO)'
          }
        >
          <span>
            <Button
              variant="contained"
              color="primary"
              startIcon={<AddIcon />}
              disabled={!canCreate}
              onClick={() => setAddDialogOpen(true)}
            >
              Add IP Address
            </Button>
          </span>
        </Tooltip>
      </Box>

      {ipAddresses.length === 0 ? (
        <Alert severity="info">
          No IP addresses found matching your filters.
        </Alert>
      ) : (
        <>
          <Typography variant="body2" color="textSecondary" gutterBottom>
            Showing {ipAddresses.length} IP address
            {ipAddresses.length !== 1 ? 'es' : ''}
          </Typography>

          <TableContainer component={Paper} className={classes.tableContainer}>
            <Table
              stickyHeader
              size="small"
              className={classes.table}
              style={{
                width: columns.visibleColumns.reduce(
                  (sum, c) => sum + widthOf(c.id),
                  0,
                ),
              }}
            >
              <colgroup>
                {columns.visibleColumns.map(c => (
                  <col key={c.id} style={{ width: widthOf(c.id) }} />
                ))}
              </colgroup>
              <TableHead>
                <TableRow className={classes.headerRow}>
                  {columns.visibleColumns.map(c => (
                    <TableCell key={c.id} className={classes.headerCell}>
                      {c.label}
                      <Tooltip title="Drag to resize, double-click to reset (or focus and use ← →)">
                        <button
                          type="button"
                          className={classes.resizeHandle}
                          aria-label={`Resize ${c.label} column`}
                          onMouseDown={startResize(c.id)}
                          onDoubleClick={() => columns.resetWidth(c.id)}
                          onKeyDown={e => {
                            if (
                              e.key === 'ArrowLeft' ||
                              e.key === 'ArrowRight'
                            ) {
                              e.preventDefault();
                              columns.setWidth(
                                c.id,
                                columns.widthOf(c.id) +
                                  (e.key === 'ArrowRight' ? 10 : -10),
                              );
                            } else if (e.key === 'Enter') {
                              e.preventDefault();
                              columns.resetWidth(c.id);
                            }
                          }}
                        />
                      </Tooltip>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {ipAddresses.map(ip => (
                  <TableRow key={ip.id} hover>
                    {columns.visibleColumns.map(c => (
                      <TableCell
                        key={c.id}
                        className={classes.bodyCell}
                        title={cellTitle(c.id, ip)}
                      >
                        {renderCell(c.id, ip)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <AddIPDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onAdd={handleAddIP}
        subnets={subnets}
        vlans={vlans}
      />
    </Box>
  );
};
