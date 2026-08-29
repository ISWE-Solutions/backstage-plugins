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
import { IPAddress, IPStatus, Subnet, VLAN } from '../../types';

const useStyles = makeStyles(theme => ({
  form: {
    width: '100%',
  },
  field: {
    marginBottom: theme.spacing(2),
  },
}));

interface AddIPDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (ip: Omit<IPAddress, 'id' | 'createdAt' | 'updatedAt'>) => void;
  subnets: Subnet[];
  vlans: VLAN[];
}

export const AddIPDialog: React.FC<AddIPDialogProps> = ({
  open,
  onClose,
  onAdd,
  subnets,
  vlans,
}) => {
  const classes = useStyles();
  const [formData, setFormData] = useState({
    ipAddress: '',
    subnetId: '',
    hostname: '',
    description: '',
    status: IPStatus.AVAILABLE,
    assignedTo: '',
    macAddress: '',
    deviceType: '',
    location: '',
    vlanId: '',
    notes: '',
  });

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSubmit = () => {
    const ipData: Omit<IPAddress, 'id' | 'createdAt' | 'updatedAt'> = {
      ...formData,
      hostname: formData.hostname || undefined,
      description: formData.description || undefined,
      assignedTo: formData.assignedTo || undefined,
      macAddress: formData.macAddress || undefined,
      deviceType: formData.deviceType || undefined,
      location: formData.location || undefined,
      vlanId: formData.vlanId || undefined,
      notes: formData.notes || undefined,
      lastSeen:
        formData.status === IPStatus.ALLOCATED
          ? new Date().toISOString()
          : undefined,
    };

    onAdd(ipData);
    handleClose();
  };

  const handleClose = () => {
    setFormData({
      ipAddress: '',
      subnetId: '',
      hostname: '',
      description: '',
      status: IPStatus.AVAILABLE,
      assignedTo: '',
      macAddress: '',
      deviceType: '',
      location: '',
      vlanId: '',
      notes: '',
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

  const isValidMAC = (mac: string) => {
    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    return macRegex.test(mac);
  };

  const isFormValid = () => {
    return (
      formData.ipAddress &&
      isValidIP(formData.ipAddress) &&
      formData.subnetId &&
      (formData.macAddress === '' || isValidMAC(formData.macAddress))
    );
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>Add IP Address</DialogTitle>
      <DialogContent>
        <Box className={classes.form}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                required
                label="IP Address"
                variant="outlined"
                value={formData.ipAddress}
                onChange={e => handleChange('ipAddress', e.target.value)}
                placeholder="192.168.1.10"
                error={
                  formData.ipAddress !== '' && !isValidIP(formData.ipAddress)
                }
                helperText={
                  formData.ipAddress !== '' && !isValidIP(formData.ipAddress)
                    ? 'Invalid IP address format'
                    : ''
                }
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                required
                select
                label="Subnet"
                variant="outlined"
                value={formData.subnetId}
                onChange={e => handleChange('subnetId', e.target.value)}
                className={classes.field}
              >
                <MenuItem value="">Select Subnet</MenuItem>
                {subnets.map(subnet => (
                  <MenuItem key={subnet.id} value={subnet.id}>
                    {subnet.network}/{subnet.cidr} - {subnet.description}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Hostname"
                variant="outlined"
                value={formData.hostname}
                onChange={e => handleChange('hostname', e.target.value)}
                placeholder="server-01.example.net"
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                select
                label="Status"
                variant="outlined"
                value={formData.status}
                onChange={e => handleChange('status', e.target.value)}
                className={classes.field}
              >
                <MenuItem value={IPStatus.AVAILABLE}>Available</MenuItem>
                <MenuItem value={IPStatus.ALLOCATED}>Allocated</MenuItem>
                <MenuItem value={IPStatus.RESERVED}>Reserved</MenuItem>
                <MenuItem value={IPStatus.QUARANTINE}>Quarantine</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Description"
                variant="outlined"
                value={formData.description}
                onChange={e => handleChange('description', e.target.value)}
                placeholder="Brief description of the device or service"
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Assigned To"
                variant="outlined"
                value={formData.assignedTo}
                onChange={e => handleChange('assignedTo', e.target.value)}
                placeholder="Department or person"
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Device Type"
                variant="outlined"
                value={formData.deviceType}
                onChange={e => handleChange('deviceType', e.target.value)}
                placeholder="Server, Workstation, etc."
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="MAC Address"
                variant="outlined"
                value={formData.macAddress}
                onChange={e => handleChange('macAddress', e.target.value)}
                placeholder="00:1A:2B:3C:4D:5E"
                error={
                  formData.macAddress !== '' && !isValidMAC(formData.macAddress)
                }
                helperText={
                  formData.macAddress !== '' && !isValidMAC(formData.macAddress)
                    ? 'Invalid MAC address format'
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
                label="Location"
                variant="outlined"
                value={formData.location}
                onChange={e => handleChange('location', e.target.value)}
                placeholder="Building, floor, rack, etc."
                className={classes.field}
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                multiline
                rows={3}
                label="Notes"
                variant="outlined"
                value={formData.notes}
                onChange={e => handleChange('notes', e.target.value)}
                placeholder="Additional notes or comments"
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
          Add IP Address
        </Button>
      </DialogActions>
    </Dialog>
  );
};
