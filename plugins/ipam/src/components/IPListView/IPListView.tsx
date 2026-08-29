import { useEffect, useState } from 'react';
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
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import SearchIcon from '@material-ui/icons/Search';
import AddIcon from '@material-ui/icons/Add';
import { IPAddress, IPStatus, IPFilter, Subnet, VLAN } from '../../types';
import { ipamService } from '../../services/ipamService';
import { AddIPDialog } from '../AddIPDialog/AddIPDialog';

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
  statusChip: {
    minWidth: 90,
  },
  headerRow: {
    backgroundColor: theme.palette.grey[100],
  },
}));

const getStatusColor = (status: IPStatus) => {
  switch (status) {
    case IPStatus.AVAILABLE:
      return 'default';
    case IPStatus.ALLOCATED:
      return 'primary';
    case IPStatus.RESERVED:
      return 'secondary';
    case IPStatus.QUARANTINE:
      return 'error';
    default:
      return 'default';
  }
};

export const IPListView = () => {
  const classes = useStyles();
  const [ipAddresses, setIPAddresses] = useState<IPAddress[]>([]);
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [vlans, setVLANs] = useState<VLAN[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<IPFilter>({});
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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
          <MenuItem value={IPStatus.AVAILABLE}>Available</MenuItem>
          <MenuItem value={IPStatus.ALLOCATED}>Allocated</MenuItem>
          <MenuItem value={IPStatus.RESERVED}>Reserved</MenuItem>
          <MenuItem value={IPStatus.QUARANTINE}>Quarantine</MenuItem>
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
          variant="contained"
          color="primary"
          startIcon={<AddIcon />}
          onClick={() => setAddDialogOpen(true)}
        >
          Add IP Address
        </Button>
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
            <Table stickyHeader>
              <TableHead>
                <TableRow className={classes.headerRow}>
                  <TableCell>IP Address</TableCell>
                  <TableCell>Hostname</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Subnet</TableCell>
                  <TableCell>VLAN</TableCell>
                  <TableCell>Assigned To</TableCell>
                  <TableCell>Device Type</TableCell>
                  <TableCell>MAC Address</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell>Last Seen</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {ipAddresses.map(ip => (
                  <TableRow key={ip.id} hover>
                    <TableCell>
                      <Typography
                        variant="body2"
                        style={{ fontFamily: 'monospace' }}
                      >
                        {ip.ipAddress}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {ip.hostname || '-'}
                      </Typography>
                      {ip.description && (
                        <Typography variant="caption" color="textSecondary">
                          {ip.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={ip.status}
                        size="small"
                        color={getStatusColor(ip.status) as any}
                        className={classes.statusChip}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        style={{ fontFamily: 'monospace' }}
                      >
                        {getSubnetDisplay(ip.subnetId)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {getVLANDisplay(ip.vlanId)}
                      </Typography>
                    </TableCell>
                    <TableCell>{ip.assignedTo || '-'}</TableCell>
                    <TableCell>{ip.deviceType || '-'}</TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        style={{ fontFamily: 'monospace' }}
                      >
                        {ip.macAddress || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>{ip.location || '-'}</TableCell>
                    <TableCell>
                      {ip.lastSeen
                        ? new Date(ip.lastSeen).toLocaleString()
                        : '-'}
                    </TableCell>
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
