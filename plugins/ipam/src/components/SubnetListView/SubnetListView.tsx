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
  Typography,
  Button,
  LinearProgress,
  Chip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import AddIcon from '@material-ui/icons/Add';
import { Subnet, VLAN } from '../../types';
import { ipamService } from '../../services/ipamService';
import { AddSubnetDialog } from '../AddSubnetDialog/AddSubnetDialog';

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
  tableContainer: {
    maxHeight: 600,
  },
  headerRow: {
    backgroundColor: theme.palette.grey[100],
  },
  utilizationBar: {
    height: 8,
    borderRadius: 4,
    marginTop: theme.spacing(0.5),
  },
  utilizationText: {
    marginTop: theme.spacing(0.5),
  },
}));

const getUtilizationColor = (percent: number) => {
  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warning';
  return 'success';
};

export const SubnetListView = () => {
  const classes = useStyles();
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [vlans, setVLANs] = useState<VLAN[]>([]);
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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

  if (loading) {
    return <LinearProgress />;
  }

  return (
    <Box className={classes.root}>
      <Box className={classes.header}>
        <Typography variant="h5">Subnets</Typography>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddIcon />}
          onClick={() => setAddDialogOpen(true)}
        >
          Add Subnet
        </Button>
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

          <TableContainer component={Paper} className={classes.tableContainer}>
            <Table stickyHeader>
              <TableHead>
                <TableRow className={classes.headerRow}>
                  <TableCell>Network</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Gateway</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell>IP Utilization</TableCell>
                  <TableCell align="right">Total IPs</TableCell>
                  <TableCell align="right">Used</TableCell>
                  <TableCell align="right">Available</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {subnets.map(subnet => (
                  <TableRow key={subnet.id} hover>
                    <TableCell>
                      <Typography
                        variant="body2"
                        style={{ fontFamily: 'monospace', fontWeight: 'bold' }}
                      >
                        {subnet.network}/{subnet.cidr}
                      </Typography>
                    </TableCell>
                    <TableCell>{subnet.description || '-'}</TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        style={{ fontFamily: 'monospace' }}
                      >
                        {subnet.gateway || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>{subnet.location || '-'}</TableCell>
                    <TableCell>
                      <Box width={200}>
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
                          color={
                            getUtilizationColor(
                              subnet.utilizationPercent,
                            ) as any
                          }
                          className={classes.utilizationBar}
                        />
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Chip label={subnet.totalIPs} size="small" />
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        label={subnet.usedIPs}
                        size="small"
                        color={
                          getUtilizationColor(subnet.utilizationPercent) as any
                        }
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        label={subnet.availableIPs}
                        size="small"
                        color="default"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
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
