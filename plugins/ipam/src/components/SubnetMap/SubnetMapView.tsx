import { useEffect, useState } from 'react';
import { Box, LinearProgress, MenuItem, TextField } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { IpamConfig, ipamApiRef } from '../../services/ipamService';
import { IPAddress, Subnet } from '../../types';
import { SubnetMap } from './SubnetMap';
import { AddressDetail } from '../AddressDetail/AddressDetail';

/** "Map" tab: pick a subnet and see every host address as a coloured grid */
export const SubnetMapView = () => {
  const ipamService = useApi(ipamApiRef);
  const [subnets, setSubnets] = useState<Subnet[]>();
  const [subnetId, setSubnetId] = useState<string>();
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [config, setConfig] = useState<IpamConfig>();
  const [selected, setSelected] = useState<IPAddress>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([ipamService.getSubnets(), ipamService.getConfig()])
      .then(([s, c]) => {
        setSubnets(s.subnets);
        setConfig(c);
        // default to the largest-utilised mappable subnet (the DC1 LAN)
        const mappable = s.subnets.filter(x => x.cidr >= 22 && x.cidr <= 30);
        const first = [...mappable].sort((a, b) => b.usedIPs - a.usedIPs)[0];
        setSubnetId(first?.id);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [ipamService]);

  const load = (id: string) =>
    ipamService
      .getIPAddresses({ subnetId: id })
      .then(r => setAddresses(r.addresses))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    if (subnetId) load(subnetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subnetId]);

  if (error)
    return (
      <Alert severity="error">
        Failed to load IPAM data from phpIPAM: {error}
      </Alert>
    );
  if (!subnets || !config) return <LinearProgress />;
  const subnet = subnets.find(s => s.id === subnetId);

  return (
    <Box p={3}>
      <TextField
        id="ipam-map-subnet"
        select
        label="Subnet"
        variant="outlined"
        size="small"
        value={subnetId ?? ''}
        onChange={e => setSubnetId(e.target.value)}
        style={{ minWidth: 320, marginBottom: 16 }}
      >
        {subnets.map(s => (
          <MenuItem key={s.id} value={s.id}>
            {s.network}/{s.cidr} — {s.description ?? ''} ({s.usedIPs} used)
          </MenuItem>
        ))}
      </TextField>
      {subnet ? (
        <SubnetMap
          subnet={subnet}
          addresses={addresses}
          dhcpRanges={config.dhcpRanges}
          onSelect={setSelected}
        />
      ) : (
        <Alert severity="info">No subnet selected.</Alert>
      )}
      <AddressDetail
        address={selected}
        subnetLabel={subnet ? `${subnet.network}/${subnet.cidr}` : undefined}
        proxmoxUiUrls={config.proxmoxUiUrls}
        onClose={() => setSelected(undefined)}
        onChanged={() => {
          setSelected(undefined);
          if (subnetId) load(subnetId);
        }}
      />
    </Box>
  );
};
