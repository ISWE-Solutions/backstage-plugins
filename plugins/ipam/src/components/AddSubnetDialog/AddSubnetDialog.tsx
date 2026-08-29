import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Grid,
  MenuItem,
  Box,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { Subnet, VLAN } from '../../types';

const useStyles = makeStyles(theme => ({
  form: {
    width: '100%',
  },
  field: {
    marginBottom: theme.spacing(2),
  },
}));

interface AddSubnetDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (subnet: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'>) => void;
  vlans: VLAN[];
}

export const AddSubnetDialog: React.FC<AddSubnetDialogProps> = ({
  open,
  onClose,
  onAdd,
  vlans,
}) => {
  const classes = useStyles();
  const [formData, setFormData] = useState({
    network: '',
    cidr: 24,
    gateway: '',
    description: '',
    vlanId: '',
    location: '',
  });

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value,
    }));
  };

  const calculateIPCounts = (cidr: number) => {
    const totalIPs = Math.pow(2, 32 - cidr) - 2; // Subtract network and broadcast
    return {
      totalIPs,
      usedIPs: 0,
      availableIPs: totalIPs,
      utilizationPercent: 0,
    };
  };

  const handleSubmit = () => {
    const ipCounts = calculateIPCounts(formData.cidr);

    const subnetData: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'> = {
      network: formData.network,
      cidr: formData.cidr,
      gateway: formData.gateway || undefined,
      description: formData.description || undefined,
      vlanId: formData.vlanId || undefined,
      location: formData.location || undefined,
      ...ipCounts,
    };

    onAdd(subnetData);
    handleClose();
  };

  const handleClose = () => {
    setFormData({
      network: '',
      cidr: 24,
      gateway: '',
      description: '',
      vlanId: '',
      location: '',
    });
    onClose();
  };

  const isValidIP = (ip: string) => {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) return false;
    return ip
      .split('.')
      .every(octet => parseInt(octet) >= 0 && parseInt(octet) <= 255);
  };

  const isFormValid = () => {
    return (
      formData.network &&
      isValidIP(formData.network) &&
      formData.cidr >= 8 &&
      formData.cidr <= 30
    );
  };

  const calculateTotalIPs = () => {
    if (formData.cidr >= 8 && formData.cidr <= 30) {
      return (Math.pow(2, 32 - formData.cidr) - 2).toLocaleString();
    }
    return '0';
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>Add Subnet</DialogTitle>
      <DialogContent>
        <Box className={classes.form}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={8}>
              <TextField
                fullWidth
                required
                label="Network Address"
                variant="outlined"
                value={formData.network}
                onChange={e => handleChange('network', e.target.value)}
                placeholder="192.168.1.0"
                error={formData.network !== '' && !isValidIP(formData.network)}
                helperText={
                  formData.network !== '' && !isValidIP(formData.network)
                    ? 'Invalid network address format'
                    : 'Enter the network address (e.g., 192.168.1.0)'
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                required
                type="number"
                label="CIDR"
                variant="outlined"
                value={formData.cidr}
                onChange={e => handleChange('cidr', parseInt(e.target.value))}
                inputProps={{ min: 8, max: 30 }}
                error={formData.cidr < 8 || formData.cidr > 30}
                helperText={
                  formData.cidr < 8 || formData.cidr > 30
                    ? 'CIDR must be between 8 and 30'
                    : `≈ ${calculateTotalIPs()} IPs`
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Gateway"
                variant="outlined"
                value={formData.gateway}
                onChange={e => handleChange('gateway', e.target.value)}
                placeholder="192.168.1.1"
                error={formData.gateway !== '' && !isValidIP(formData.gateway)}
                helperText={
                  formData.gateway !== '' && !isValidIP(formData.gateway)
                    ? 'Invalid gateway address'
                    : ''
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                select
                label="VLAN"
                variant="outlined"
                value={formData.vlanId}
                onChange={e => handleChange('vlanId', e.target.value)}
                className={classes.field}
              >
                <MenuItem value="">No VLAN</MenuItem>
                {vlans.map(vlan => (
                  <MenuItem key={vlan.id} value={vlan.id}>
                    VLAN {vlan.vlanId} - {vlan.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Description"
                variant="outlined"
                value={formData.description}
                onChange={e => handleChange('description', e.target.value)}
                placeholder="Brief description of the subnet"
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Location"
                variant="outlined"
                value={formData.location}
                onChange={e => handleChange('location', e.target.value)}
                placeholder="Physical location or site name"
                className={classes.field}
              />
            </Grid>
          </Grid>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="default">
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          color="primary"
          variant="contained"
          disabled={!isFormValid()}
        >
          Add Subnet
        </Button>
      </DialogActions>
    </Dialog>
  );
};
