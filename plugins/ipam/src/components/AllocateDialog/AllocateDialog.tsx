import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { ipamApiRef } from '../../services/ipamService';

const HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/;

interface Props {
  open: boolean;
  onClose: (allocated: boolean) => void;
}

/**
 * Reserve the next free address from the IPAM allocation pool, for a
 * container being created by hand. DHIS2 create/clone do this automatically.
 */
export const AllocateDialog = ({ open, onClose }: Props) => {
  const ipamService = useApi(ipamApiRef);
  const [hostname, setHostname] = useState('');
  const [purpose, setPurpose] = useState('');
  const [pool, setPool] = useState<{ from: string; to: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{
    ip: string;
    prefix: number;
    gateway: string;
    nameserver?: string;
  }>();

  useEffect(() => {
    if (open) {
      ipamService
        .getAllocationPool()
        .then(setPool)
        .catch(() => setPool(undefined));
    }
  }, [open, ipamService]);

  const reset = () => {
    setHostname('');
    setPurpose('');
    setError(undefined);
    setResult(undefined);
  };
  const close = () => {
    const allocated = Boolean(result);
    reset();
    onClose(allocated);
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await ipamService.allocate({
          hostname: hostname.trim(),
          purpose: purpose.trim(),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const valid =
    HOSTNAME.test(hostname.trim()) &&
    purpose.trim().length > 0 &&
    purpose.length <= 200;

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Allocate next IP address</DialogTitle>
      <DialogContent>
        {result ? (
          <Box>
            <Alert severity="success">
              Reserved <strong>{result.ip}</strong> for {hostname}.
            </Alert>
            <Box mt={2}>
              <Typography variant="body2">
                Address:{' '}
                <code>
                  {result.ip}/{result.prefix}
                </code>{' '}
                — gateway <code>{result.gateway}</code>
                {result.nameserver && (
                  <>
                    {' '}
                    — DNS <code>{result.nameserver}</code>
                  </>
                )}
              </Typography>
              <Typography variant="body2" gutterBottom>
                Proxmox container network:
              </Typography>
              <Typography
                variant="body2"
                component="pre"
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {`name=eth0,bridge=vmbr0,ip=${result.ip}/${result.prefix},gw=${result.gateway}`}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                The address stays Reserved until the discovery sync sees it in
                use. Release unused reservations on the IP Addresses tab.
              </Typography>
            </Box>
          </Box>
        ) : (
          <Box>
            <Typography variant="body2" color="textSecondary" gutterBottom>
              Picks the lowest free address
              {pool ? ` in ${pool.from}–${pool.to}` : ''} that phpIPAM does not
              know and nothing answers on, and reserves it in your name.
            </Typography>
            <TextField
              id="ipam-allocate-hostname"
              label="Hostname"
              value={hostname}
              onChange={e => setHostname(e.target.value)}
              fullWidth
              margin="dense"
              required
              error={hostname !== '' && !HOSTNAME.test(hostname.trim())}
              helperText="Container hostname, e.g. reports-uat"
            />
            <TextField
              id="ipam-allocate-purpose"
              label="Purpose"
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              fullWidth
              margin="dense"
              required
              inputProps={{ maxLength: 200 }}
              helperText="What the address is for, recorded in phpIPAM"
            />
            {error && (
              <Box mt={1}>
                <Alert severity="error">{error}</Alert>
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{result ? 'Done' : 'Cancel'}</Button>
        {!result && (
          <Button
            color="primary"
            variant="contained"
            disabled={!valid || busy}
            onClick={submit}
          >
            {busy ? 'Allocating…' : 'Allocate'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
