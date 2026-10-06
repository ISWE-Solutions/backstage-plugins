import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Tooltip,
  LinearProgress,
  Chip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import AddIcon from '@material-ui/icons/Add';
import { Subnet, VLAN } from '../../types';
import { useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { ipamSubnetCreatePermission } from '@iswesolutions/plugin-ipam-common';
import { ipamApiRef } from '../../services/ipamService';
import { AddSubnetDialog } from '../AddSubnetDialog/AddSubnetDialog';
import { AddVlanButton, SubnetActions } from './SubnetActions';
import {
  ColumnDefinition,
  ColumnsMenuButton,
  ManagedTable,
  useColumnSettings,
} from '../ManagedTable/ManagedTable';
import { downloadText, toCsv } from '../IPListView/csv';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(3),
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing(3),
  },
  mono: {
    fontFamily: 'monospace',
  },
  utilizationBar: {
    height: 8,
    borderRadius: 4,
    marginTop: theme.spacing(0.5),
  },
}));

const COLUMNS_STORAGE_KEY = 'ipam.subnetListView.columns.v1';

const COLUMNS: ColumnDefinition[] = [
  { id: 'network', label: 'Network', defaultWidth: 160 },
  { id: 'description', label: 'Description', defaultWidth: 220 },
  { id: 'gateway', label: 'Gateway', defaultWidth: 130 },
  { id: 'vlan', label: 'VLAN', defaultWidth: 140, defaultVisible: false },
  {
    id: 'location',
    label: 'Location',
    defaultWidth: 140,
    defaultVisible: false,
  },
  { id: 'utilization', label: 'IP Utilization', defaultWidth: 220 },
  { id: 'total', label: 'Total IPs', defaultWidth: 100 },
  { id: 'used', label: 'Used', defaultWidth: 90 },
  { id: 'available', label: 'Available', defaultWidth: 100 },
  { id: 'actions', label: 'Actions', defaultWidth: 200 },
];

const getUtilizationColor = (percent: number) => {
  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warning';
  return 'success';
};

export const SubnetListView = () => {
  const ipamService = useApi(ipamApiRef);
  const { allowed: canCreate } = usePermission({
    permission: ipamSubnetCreatePermission,
  });
  const classes = useStyles();
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [vlans, setVLANs] = useState<VLAN[]>([]);
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const columns = useColumnSettings(COLUMNS_STORAGE_KEY, COLUMNS);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [subnetData, vlanData] = await Promise.all([
        ipamService.getSubnets(),
        ipamService.getVLANs(),
      ]);
      setSubnets(subnetData.subnets);
      setVLANs(vlanData.vlans);
    } catch (error) {
      console.error('Failed to fetch subnets:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAddSubnet = async (
    subnet: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'>,
  ) => {
    try {
      await ipamService.addSubnet(subnet);
      setAddDialogOpen(false);
      fetchData();
    } catch (error) {
      console.error('Failed to add subnet:', error);
    }
  };

  const vlanLabel = (subnet: Subnet) => {
    if (!subnet.vlanId) return '';
    const vlan = vlans.find(v => v.id === subnet.vlanId);
    return vlan ? `${vlan.vlanId} ${vlan.name}` : subnet.vlanId;
  };

  const cellTitle = (columnId: string, subnet: Subnet): string => {
    switch (columnId) {
      case 'network':
        return `${subnet.network}/${subnet.cidr}`;
      case 'description':
        return subnet.description ?? '';
      case 'gateway':
        return subnet.gateway ?? '';
      case 'vlan':
        return vlanLabel(subnet);
      case 'location':
        return subnet.location ?? '';
      case 'utilization':
        return `${subnet.utilizationPercent.toFixed(1)}% (${subnet.usedIPs} / ${
          subnet.totalIPs
        })`;
      case 'total':
        return String(subnet.totalIPs);
      case 'used':
        return String(subnet.usedIPs);
      case 'available':
        return String(subnet.availableIPs);
      default:
        return '';
    }
  };

  const exportCsv = () => {
    const cols = columns.visibleColumns.filter(c => c.id !== 'actions');
    const rows = [
      cols.map(c => c.label),
      ...subnets.map(s => cols.map(c => cellTitle(c.id, s))),
    ];
    downloadText(
      `ipam-subnets-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(rows),
    );
  };

  const renderCell = (columnId: string, subnet: Subnet) => {
    const color = getUtilizationColor(subnet.utilizationPercent) as any;
    switch (columnId) {
      case 'network':
        return (
          <Typography
            variant="body2"
            noWrap
            style={{ fontFamily: 'monospace', fontWeight: 'bold' }}
          >
            {subnet.network}/{subnet.cidr}
          </Typography>
        );
      case 'gateway':
        return <span className={classes.mono}>{subnet.gateway || '-'}</span>;
      case 'utilization':
        return (
          <Box>
            <Box display="flex" justifyContent="space-between">
              <Typography variant="caption">
                {subnet.utilizationPercent.toFixed(1)}%
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {subnet.usedIPs} / {subnet.totalIPs}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={subnet.utilizationPercent}
              color={color}
              className={classes.utilizationBar}
            />
          </Box>
        );
      case 'total':
        return <Chip label={subnet.totalIPs} size="small" />;
      case 'used':
        return <Chip label={subnet.usedIPs} size="small" color={color} />;
      case 'available':
        return (
          <Chip label={subnet.availableIPs} size="small" color="default" />
        );
      case 'actions':
        return (
          <SubnetActions subnet={subnet} vlans={vlans} onChanged={fetchData} />
        );
      default:
        return cellTitle(columnId, subnet) || '-';
    }
  };

  if (loading) {
    return <LinearProgress />;
  }

  return (
    <Box className={classes.root}>
      <Box className={classes.header}>
        <Typography variant="h5">Subnets</Typography>
        <Box flexGrow={1} />
        <Button
          variant="outlined"
          size="small"
          onClick={exportCsv}
          disabled={subnets.length === 0}
        >
          Export CSV
        </Button>
        <Box width={8} />
        <ColumnsMenuButton
          id="ipam-subnets"
          columns={COLUMNS}
          settings={columns}
        />
        <Box width={8} />
        <AddVlanButton onChanged={fetchData} />
        <Box width={8} />
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
              Add Subnet
            </Button>
          </span>
        </Tooltip>
      </Box>

      {subnets.length === 0 ? (
        <Alert severity="info">
          No subnets configured. Add a subnet to get started.
        </Alert>
      ) : (
        <>
          <Typography variant="body2" color="textSecondary" gutterBottom>
            Showing {subnets.length} subnet{subnets.length !== 1 ? 's' : ''}
          </Typography>

          <ManagedTable
            settings={columns}
            rows={subnets}
            rowKey={subnet => subnet.id}
            renderCell={renderCell}
            cellTitle={cellTitle}
            align={{ total: 'right', used: 'right', available: 'right' }}
          />
        </>
      )}

      <AddSubnetDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onAdd={handleAddSubnet}
        vlans={vlans}
      />
    </Box>
  );
};
