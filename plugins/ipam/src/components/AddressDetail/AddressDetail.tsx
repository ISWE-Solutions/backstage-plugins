import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Link,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import CloseIcon from '@material-ui/icons/Close';
import { useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ipamAddressDeletePermission,
  ipamAddressUpdatePermission,
} from '@iswesolutions/plugin-ipam-common';
import { AddressChange, ipamApiRef } from '../../services/ipamService';
import { IPAddress } from '../../types';
import { backstageSearchLink, proxmoxGuestLink } from './links';
import { DeleteAddressDialog, EditAddressDialog } from './AddressDialogs';

interface Props {
  address?: IPAddress;
  subnetLabel?: string;
  proxmoxUiUrls: Record<string, string>;
  onClose: () => void;
  /** Called after an edit or delete so the list can refresh */
  onChanged: () => void;
}

const Row = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <Box display="flex" py={0.5}>
    <Typography
      variant="body2"
      color="textSecondary"
      style={{ width: 130, flexShrink: 0 }}
    >
      {label}
    </Typography>
    <Typography
      variant="body2"
      component="div"
      style={{ wordBreak: 'break-word' }}
    >
      {children || '-'}
    </Typography>
  </Box>
);

export const AddressDetail = ({
  address,
  subnetLabel,
  proxmoxUiUrls,
  onClose,
  onChanged,
}: Props) => {
  const ipamService = useApi(ipamApiRef);
  const { allowed: canUpdate } = usePermission({
    permission: ipamAddressUpdatePermission,
  });
  const { allowed: canDelete } = usePermission({
    permission: ipamAddressDeletePermission,
  });
  const [history, setHistory] = useState<AddressChange[]>();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setHistory(undefined);
    setError(undefined);
    if (address) {
      ipamService
        .getChangelog(address.id)
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }, [address, ipamService]);

  if (!address) return null;
  const proxmox = proxmoxGuestLink(address, proxmoxUiUrls);

  return (
    <Drawer anchor="right" open onClose={onClose}>
      <Box
        width={440}
        maxWidth="100vw"
        p={3}
        role="region"
        aria-label="Address details"
      >
        <Box display="flex" alignItems="center">
          <Typography
            variant="h6"
            style={{ fontFamily: 'monospace', flexGrow: 1 }}
          >
            {address.ipAddress}
          </Typography>
          <IconButton aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Chip size="small" label={address.status} />{' '}
        <Chip
          size="small"
          variant="outlined"
          label={`source: ${address.source ?? 'manual'}`}
        />
        <Box mt={2}>
          <Row label="Hostname">{address.hostname}</Row>
          <Row label="Description">{address.description}</Row>
          <Row label="Subnet">{subnetLabel}</Row>
          <Row label="MAC">{address.macAddress}</Row>
          <Row label="Owner">{address.assignedTo}</Row>
          <Row label="Last seen">
            {address.lastSeen
              ? new Date(address.lastSeen).toLocaleString()
              : undefined}
          </Row>
          <Row label="Links">
            {proxmox && (
              <Link href={proxmox} target="_blank" rel="noopener">
                Proxmox guest
              </Link>
            )}
            {proxmox && ' · '}
            <Link href={backstageSearchLink(address)}>Search Backstage</Link>
          </Row>
        </Box>
        {address.notes && (
          <Box mt={1}>
            <Typography variant="body2" color="textSecondary">
              Note
            </Typography>
            <Typography
              variant="body2"
              component="pre"
              style={{ whiteSpace: 'pre-wrap', margin: 0 }}
            >
              {address.notes}
            </Typography>
          </Box>
        )}
        {error && (
          <Box mt={2}>
            <Alert severity="error">{error}</Alert>
          </Box>
        )}
        <Box mt={2} display="flex" style={{ gap: 8 }}>
          <Button
            variant="outlined"
            color="primary"
            disabled={!canUpdate}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            variant="outlined"
            disabled={!canDelete}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </Box>
        <Box mt={3}>
          <Divider />
          <Typography variant="subtitle2" style={{ marginTop: 16 }}>
            Change history
          </Typography>
          {history === undefined && (
            <Typography variant="body2">Loading…</Typography>
          )}
          {history?.length === 0 && (
            <Typography variant="body2" color="textSecondary">
              No recorded changes.
            </Typography>
          )}
          {history?.map((c, i) => (
            <Box key={i} py={1}>
              <Typography variant="body2">
                {c.date ? new Date(c.date).toLocaleString() : ''} — {c.user} —{' '}
                {c.action}
                {c.result ? ` (${c.result})` : ''}
              </Typography>
              {c.diff && (
                <Typography
                  variant="caption"
                  component="pre"
                  style={{ whiteSpace: 'pre-wrap', margin: 0 }}
                >
                  {c.diff}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      </Box>

      <EditAddressDialog
        address={editing ? address : undefined}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
      <DeleteAddressDialog
        address={confirmDelete ? address : undefined}
        onClose={() => setConfirmDelete(false)}
        onDeleted={() => {
          setConfirmDelete(false);
          onChanged();
          onClose();
        }}
      />
    </Drawer>
  );
};
