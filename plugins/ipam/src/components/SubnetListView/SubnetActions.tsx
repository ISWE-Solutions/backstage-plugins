import { useEffect, useState } from 'react';
import {
  Box,
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
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ipamSubnetUpdatePermission,
  ipamVlanCreatePermission,
} from '@iswesolutions/plugin-ipam-common';
import { ipamApiRef } from '../../services/ipamService';
import { IPAddress, Subnet, VLAN } from '../../types';
import { SubnetMap } from '../SubnetMap/SubnetMap';
import { AddressDetail } from '../AddressDetail/AddressDetail';

type Action = 'map' | 'split' | 'free' | 'vlan';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Map / Split / Find free / VLAN actions for one subnet row */
export const SubnetActions = ({
  subnet,
  vlans,
  onChanged,
}: {
  subnet: Subnet;
  vlans: VLAN[];
  onChanged: () => void;
}) => {
  const ipamService = useApi(ipamApiRef);
  const { allowed: canUpdate } = usePermission({
    permission: ipamSubnetUpdatePermission,
  });
  const [action, setAction] = useState<Action>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [config, setConfig] = useState<{
    dhcpRanges: { from: string; to: string }[];
    proxmoxUiUrls: Record<string, string>;
  }>({
    dhcpRanges: [],
    proxmoxUiUrls: {},
  });
  const [selected, setSelected] = useState<IPAddress>();
  const [parts, setParts] = useState(2);
  const [mask, setMask] = useState(Math.min(subnet.cidr + 2, 30));
  const [vlanId, setVlanId] = useState(subnet.vlanId ?? '');

  const loadMap = () =>
    Promise.all([
      ipamService.getIPAddresses({ subnetId: subnet.id }),
      ipamService.getConfig(),
    ])
      .then(([a, c]) => {
        setAddresses(a.addresses);
        setConfig(c);
      })
      .catch(e => setError(errorText(e)));

  useEffect(() => {
    if (action === 'map') loadMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  const close = () => {
    setAction(undefined);
    setError(undefined);
    setResult(undefined);
  };
  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setError(undefined);
    try {
      await fn();
      done?.();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Box display="flex" style={{ gap: 4 }} onClick={e => e.stopPropagation()}>
      <Button size="small" onClick={() => setAction('map')}>
        Map
      </Button>
      <Button
        size="small"
        disabled={!canUpdate}
        onClick={() => setAction('split')}
      >
        Split
      </Button>
      <Button size="small" onClick={() => setAction('free')}>
        Find free
      </Button>
      <Button
        size="small"
        disabled={!canUpdate}
        onClick={() => setAction('vlan')}
      >
        VLAN
      </Button>

      <Dialog open={action === 'map'} onClose={close} maxWidth="md">
        <DialogTitle>
          Map of {subnet.network}/{subnet.cidr}
        </DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error">{error}</Alert>
          ) : (
            <SubnetMap
              subnet={subnet}
              addresses={addresses}
              dhcpRanges={config.dhcpRanges}
              onSelect={setSelected}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Close</Button>
        </DialogActions>
        <AddressDetail
          address={selected}
          subnetLabel={`${subnet.network}/${subnet.cidr}`}
          proxmoxUiUrls={config.proxmoxUiUrls}
          onClose={() => setSelected(undefined)}
          onChanged={() => {
            setSelected(undefined);
            loadMap();
          }}
        />
      </Dialog>

      <Dialog open={action === 'split'} onClose={close}>
        <DialogTitle>
          Split {subnet.network}/{subnet.cidr}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            phpIPAM replaces the subnet with equal parts; existing addresses
            move into the part that contains them. Splitting is refused if it
            would orphan addresses.
          </Typography>
          <TextField
            id="ipam-split-parts"
            select
            label="Number of parts"
            value={parts}
            onChange={e => setParts(Number(e.target.value))}
            fullWidth
            margin="dense"
          >
            {[2, 4, 8, 16, 32]
              .filter(n => subnet.cidr + Math.log2(n) <= 30)
              .map(n => (
                <MenuItem key={n} value={n}>
                  {n} × /{subnet.cidr + Math.log2(n)}
                </MenuItem>
              ))}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button
            color="primary"
            variant="contained"
            onClick={() =>
              run(
                () => ipamService.splitSubnet(subnet.id, parts),
                () => {
                  close();
                  onChanged();
                },
              )
            }
          >
            Split
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={action === 'free'} onClose={close}>
        <DialogTitle>
          Find a free subnet in {subnet.network}/{subnet.cidr}
        </DialogTitle>
        <DialogContent>
          <TextField
            id="ipam-free-mask"
            select
            label="Size"
            value={mask}
            onChange={e => {
              setMask(Number(e.target.value));
              setResult(undefined);
            }}
            fullWidth
            margin="dense"
          >
            {Array.from(
              { length: 30 - subnet.cidr },
              (_, i) => subnet.cidr + 1 + i,
            ).map(m => (
              <MenuItem key={m} value={m}>
                /{m} ({2 ** (32 - m) - 2} hosts)
              </MenuItem>
            ))}
          </TextField>
          {result !== undefined && (
            <Alert severity={result ? 'success' : 'info'}>
              {result
                ? `First free /${mask}: ${result}`
                : `No free /${mask} in this subnet.`}
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Close</Button>
          <Button
            color="primary"
            onClick={() =>
              run(async () =>
                setResult(
                  (await ipamService.findFreeSubnet(subnet.id, mask)) ?? '',
                ),
              )
            }
          >
            Find
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={action === 'vlan'} onClose={close}>
        <DialogTitle>
          VLAN for {subnet.network}/{subnet.cidr}
        </DialogTitle>
        <DialogContent>
          <TextField
            id="ipam-subnet-vlan"
            select
            label="VLAN"
            value={vlanId}
            onChange={e => setVlanId(e.target.value)}
            fullWidth
            margin="dense"
          >
            <MenuItem value="">None</MenuItem>
            {vlans.map(v => (
              <MenuItem key={v.id} value={v.id}>
                VLAN {v.vlanId} — {v.name}
              </MenuItem>
            ))}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button
            color="primary"
            variant="contained"
            onClick={() =>
              run(
                () => ipamService.setSubnetVlan(subnet.id, vlanId || undefined),
                () => {
                  close();
                  onChanged();
                },
              )
            }
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

/** "Add VLAN" button and dialog (ipam.vlan.create) */
export const AddVlanButton = ({ onChanged }: { onChanged: () => void }) => {
  const ipamService = useApi(ipamApiRef);
  const { allowed } = usePermission({ permission: ipamVlanCreatePermission });
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const valid =
    /^\d+$/.test(number) &&
    Number(number) >= 1 &&
    Number(number) <= 4094 &&
    name.trim() !== '';
  const save = async () => {
    try {
      await ipamService.createVlan({
        number: Number(number),
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setOpen(false);
      setNumber('');
      setName('');
      setDescription('');
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <Button
        variant="outlined"
        disabled={!allowed}
        onClick={() => setOpen(true)}
      >
        Add VLAN
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Add VLAN</DialogTitle>
        <DialogContent>
          <TextField
            id="ipam-vlan-number"
            label="VLAN ID (1–4094)"
            value={number}
            onChange={e => setNumber(e.target.value)}
            fullWidth
            margin="dense"
          />
          <TextField
            id="ipam-vlan-name"
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            fullWidth
            margin="dense"
          />
          <TextField
            id="ipam-vlan-description"
            label="Description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            fullWidth
            margin="dense"
          />
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            color="primary"
            variant="contained"
            disabled={!valid}
            onClick={save}
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
