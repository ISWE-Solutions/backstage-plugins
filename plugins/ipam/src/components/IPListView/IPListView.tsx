import { useEffect, useState } from 'react';
import {
  Box,
  TextField,
  MenuItem,
  Chip,
  Typography,
  Button,
  InputAdornment,
  LinearProgress,
  Tooltip,
  IconButton,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import SearchIcon from '@material-ui/icons/Search';
import AddIcon from '@material-ui/icons/Add';
import GetAppIcon from '@material-ui/icons/GetApp';
import EditIcon from '@material-ui/icons/Edit';
import DeleteIcon from '@material-ui/icons/Delete';
import { IPAddress, IPStatus, IPFilter, Subnet, VLAN } from '../../types';
import { useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ipamAddressCreatePermission,
  ipamAddressDeletePermission,
  ipamAddressUpdatePermission,
} from '@iswesolutions/plugin-ipam-common';
import { ipamApiRef } from '../../services/ipamService';
import { AddIPDialog } from '../AddIPDialog/AddIPDialog';
import { AllocateDialog } from '../AllocateDialog/AllocateDialog';
import { AddressDetail } from '../AddressDetail/AddressDetail';
import {
  DeleteAddressDialog,
  EditAddressDialog,
} from '../AddressDetail/AddressDialogs';
import { downloadText, toCsv } from './csv';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from '../ManagedTable/ManagedTable';

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
  mono: {
    fontFamily: 'monospace',
  },
  statusChip: {
    minWidth: 90,
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
  { id: 'actions', label: 'Actions', defaultWidth: 100 },
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
  const { allowed: canUpdate } = usePermission({
    permission: ipamAddressUpdatePermission,
  });
  const { allowed: canDelete } = usePermission({
    permission: ipamAddressDeletePermission,
  });
  const [editTarget, setEditTarget] = useState<IPAddress>();
  const [deleteTarget, setDeleteTarget] = useState<IPAddress>();
  const [ipAddresses, setIPAddresses] = useState<IPAddress[]>([]);
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [vlans, setVLANs] = useState<VLAN[]>([]);
  const [loading, setLoading] = useState(true);
  // ?q=<ip or hostname> (e.g. from Backstage search) pre-fills the search box
  const [filter, setFilter] = useState<IPFilter>(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    return q ? { search: q } : {};
  });
  const [selected, setSelected] = useState<IPAddress>();
  const [proxmoxUiUrls, setProxmoxUiUrls] = useState<Record<string, string>>(
    {},
  );
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [allocateOpen, setAllocateOpen] = useState(false);

  useEffect(() => {
    ipamService
      .getConfig()
      .then(c => setProxmoxUiUrls(c.proxmoxUiUrls ?? {}))
      .catch(() => undefined);
  }, [ipamService]);
  const columns = useColumnSettings(COLUMNS_STORAGE_KEY, COLUMNS);

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
      case 'actions':
        return (
          <span>
            <Tooltip
              title={canUpdate ? 'Edit' : 'Edit — needs ipam.address.update'}
            >
              <span>
                <IconButton
                  size="small"
                  aria-label={`Edit ${ip.ipAddress}`}
                  disabled={!canUpdate}
                  onClick={e => {
                    // keep the row click (which opens the detail panel) from firing
                    e.stopPropagation();
                    setEditTarget(ip);
                  }}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip
              title={
                canDelete ? 'Delete' : 'Delete — needs ipam.address.delete'
              }
            >
              <span>
                <IconButton
                  size="small"
                  aria-label={`Delete ${ip.ipAddress}`}
                  disabled={!canDelete}
                  onClick={e => {
                    e.stopPropagation();
                    setDeleteTarget(ip);
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </span>
        );
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
      case 'status':
        return ip.status;
      default:
        return '';
    }
  };

  const exportCsv = () => {
    const cols = columns.visibleColumns.filter(c => c.id !== 'actions');
    const rows = [
      cols.map(c => c.label),
      ...ipAddresses.map(ip => cols.map(c => cellTitle(c.id, ip))),
    ];
    downloadText(
      `ipam-addresses-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(rows),
    );
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
          startIcon={<GetAppIcon />}
          onClick={exportCsv}
          disabled={ipAddresses.length === 0}
        >
          Export CSV
        </Button>
        <ColumnsMenuButton
          id="ipam-addresses"
          columns={COLUMNS}
          settings={columns}
        />

        <Button
          variant="outlined"
          color="primary"
          disabled={!canCreate}
          onClick={() => setAllocateOpen(true)}
        >
          Allocate next IP
        </Button>

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

          <ManagedTable
            settings={columns}
            rows={ipAddresses}
            rowKey={ip => ip.id}
            renderCell={renderCell}
            cellTitle={cellTitle}
            onRowClick={setSelected}
          />
        </>
      )}

      <EditAddressDialog
        address={editTarget}
        onClose={() => setEditTarget(undefined)}
        onSaved={() => {
          setEditTarget(undefined);
          fetchData();
        }}
      />
      <DeleteAddressDialog
        address={deleteTarget}
        onClose={() => setDeleteTarget(undefined)}
        onDeleted={() => {
          setDeleteTarget(undefined);
          fetchData();
        }}
      />

      <AddressDetail
        address={selected}
        subnetLabel={selected ? getSubnetDisplay(selected.subnetId) : undefined}
        proxmoxUiUrls={proxmoxUiUrls}
        onClose={() => setSelected(undefined)}
        onChanged={() => {
          setSelected(undefined);
          fetchData();
        }}
      />

      <AllocateDialog
        open={allocateOpen}
        onClose={allocated => {
          setAllocateOpen(false);
          if (allocated) fetchData();
        }}
      />

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
