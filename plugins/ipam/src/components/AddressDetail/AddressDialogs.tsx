import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { ipamApiRef } from '../../services/ipamService';
import { IPAddress, IPStatus } from '../../types';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Edit an address's hostname, description, owner, MAC, status and note */
export const EditAddressDialog = ({
  address,
  onClose,
  onSaved,
}: {
  address?: IPAddress;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const ipamService = useApi(ipamApiRef);
  const [form, setForm] = useState<Partial<IPAddress>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    if (address) {
      setForm({
        hostname: address.hostname ?? '',
        description: address.description ?? '',
        assignedTo: address.assignedTo ?? '',
        macAddress: address.macAddress ?? '',
        status: address.status,
        notes: address.notes ?? '',
      });
    }
  }, [address]);

  const save = async () => {
    if (!address) return;
    try {
      await ipamService.updateAddress(address.id, form);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const field = (key: keyof IPAddress, label: string, extra: object = {}) => (
    <TextField
      id={`ipam-edit-${key}`}
      label={label}
      value={(form[key] as string) ?? ''}
      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      fullWidth
      margin="dense"
      {...extra}
    />
  );

  return (
    <Dialog open={!!address} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit {address?.ipAddress}</DialogTitle>
      <DialogContent>
        {field('hostname', 'Hostname')}
        {field('description', 'Description')}
        {field('assignedTo', 'Owner')}
        {field('macAddress', 'MAC address')}
        <TextField
          id="ipam-edit-status"
          select
          label="Status"
          value={form.status ?? IPStatus.ALLOCATED}
          onChange={e =>
            setForm(f => ({ ...f, status: e.target.value as IPStatus }))
          }
          fullWidth
          margin="dense"
        >
          <MenuItem value={IPStatus.ALLOCATED}>Used</MenuItem>
          <MenuItem value={IPStatus.RESERVED}>Reserved</MenuItem>
          <MenuItem value={IPStatus.OFFLINE}>Offline</MenuItem>
          <MenuItem value={IPStatus.DHCP}>DHCP</MenuItem>
        </TextField>
        {field('notes', 'Note', { multiline: true, minRows: 3 })}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="primary" variant="contained" onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/** Confirm and delete an address record */
export const DeleteAddressDialog = ({
  address,
  onClose,
  onDeleted,
}: {
  address?: IPAddress;
  onClose: () => void;
  onDeleted: () => void;
}) => {
  const ipamService = useApi(ipamApiRef);
  const [error, setError] = useState<string>();
  useEffect(() => setError(undefined), [address]);
  const remove = async () => {
    if (!address) return;
    try {
      await ipamService.deleteAddress(address.id);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog open={!!address} onClose={onClose}>
      <DialogTitle>Delete {address?.ipAddress}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          The record{address?.hostname ? ` for ${address.hostname}` : ''} is
          removed from phpIPAM. If the address is still in use, discovery will
          add it back as a new record.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="secondary" variant="contained" onClick={remove}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
};
