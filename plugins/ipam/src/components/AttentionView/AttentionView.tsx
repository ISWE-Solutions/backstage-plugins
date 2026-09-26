import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { useApi } from '@backstage/core-plugin-api';
import { ipamApiRef } from '../../services/ipamService';
import { downloadText, toCsv } from '../IPListView/csv';
import { IPAddress, Subnet } from '../../types';
import {
  AttentionCategory,
  CATEGORY_INFO,
  CATEGORY_ORDER,
  findAttentionItems,
} from '@internal/plugin-ipam-common';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(3),
  },
  controls: {
    display: 'flex',
    gap: theme.spacing(2),
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: theme.spacing(2),
  },
  chips: {
    display: 'flex',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  },
  mono: {
    fontFamily: 'monospace',
  },
  tableContainer: {
    maxHeight: 600,
  },
}));

const CATEGORY_COLOR: Record<AttentionCategory, 'secondary' | 'default'> = {
  conflict: 'secondary',
  unknown: 'secondary',
  sharedMac: 'secondary',
  drift: 'default',
  dhcpPoolStatic: 'secondary',
  stale: 'default',
  staleReservation: 'default',
  stoppedGuest: 'default',
};

export const AttentionView = () => {
  const classes = useStyles();
  const ipamService = useApi(ipamApiRef);
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [staleDays, setStaleDays] = useState(7);
  const [category, setCategory] = useState<AttentionCategory>();
  const [dhcpRanges, setDhcpRanges] = useState<{ from: string; to: string }[]>(
    [],
  );
  const [dns, setDns] = useState<{
    checkedAt?: string;
    mismatches?: { ip: string; hostname: string; problem: string }[];
    error?: string;
    running?: boolean;
  }>({});
  const runDnsCheck = () => {
    setDns({ running: true });
    ipamService
      .getDnsCheck()
      .then(r => setDns(r))
      .catch(e =>
        setDns({ error: e instanceof Error ? e.message : String(e) }),
      );
  };

  useEffect(() => {
    Promise.all([
      ipamService.getIPAddresses(),
      ipamService.getSubnets(),
      ipamService.getConfig(),
    ])
      .then(([a, s, c]) => {
        setAddresses(a.addresses);
        setSubnets(s.subnets);
        setDhcpRanges(c.dhcpRanges ?? []);
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [ipamService]);

  const items = useMemo(
    () => findAttentionItems(addresses, { staleDays, dhcpRanges }),
    [addresses, staleDays, dhcpRanges],
  );
  const counts = useMemo(() => {
    const c = {} as Record<AttentionCategory, number>;
    CATEGORY_ORDER.forEach(k => {
      c[k] = items.filter(i => i.category === k).length;
    });
    return c;
  }, [items]);
  const shown = category ? items.filter(i => i.category === category) : items;

  const subnetOf = (id: string) => {
    const s = subnets.find(x => x.id === id);
    return s ? `${s.network}/${s.cidr}` : id;
  };

  const exportCsv = () =>
    downloadText(
      `ipam-attention-${category ?? 'all'}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
      toCsv([
        [
          'Issue',
          'IP Address',
          'Hostname',
          'Subnet',
          'Source',
          'Detail',
          'Last Seen',
        ],
        ...shown.map(i => [
          CATEGORY_INFO[i.category].label,
          i.address.ipAddress,
          i.address.hostname ?? '',
          subnetOf(i.address.subnetId),
          i.address.source ?? '',
          i.detail,
          i.address.lastSeen ?? '',
        ]),
      ]),
    );

  if (loading) return <LinearProgress />;
  if (loadError) {
    return (
      <Alert severity="error">
        Failed to load IPAM data from phpIPAM: {loadError}
      </Alert>
    );
  }

  return (
    <Box className={classes.root}>
      <Box className={classes.controls}>
        <TextField
          select
          size="small"
          variant="outlined"
          label="Stale after"
          value={staleDays}
          onChange={e => setStaleDays(Number(e.target.value))}
        >
          {[7, 30, 90].map(d => (
            <MenuItem key={d} value={d}>
              {d} days without a ping
            </MenuItem>
          ))}
        </TextField>
        <Box className={classes.chips}>
          <Chip
            label={`All (${items.length})`}
            color={category ? 'default' : 'primary'}
            onClick={() => setCategory(undefined)}
          />
          {CATEGORY_ORDER.map(k => (
            <Tooltip key={k} title={CATEGORY_INFO[k].description}>
              <Chip
                label={`${CATEGORY_INFO[k].label} (${counts[k]})`}
                color={category === k ? 'primary' : 'default'}
                variant={counts[k] ? 'default' : 'outlined'}
                onClick={() => setCategory(category === k ? undefined : k)}
              />
            </Tooltip>
          ))}
        </Box>
        <Button
          variant="outlined"
          size="small"
          onClick={exportCsv}
          disabled={shown.length === 0}
        >
          Export CSV
        </Button>
      </Box>

      {category && (
        <Typography variant="body2" color="textSecondary" gutterBottom>
          {CATEGORY_INFO[category].description}
        </Typography>
      )}

      {shown.length === 0 ? (
        <Alert severity="success">
          Nothing needs attention
          {category ? ` in "${CATEGORY_INFO[category].label}"` : ''}.
        </Alert>
      ) : (
        <TableContainer component={Paper} className={classes.tableContainer}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell>Issue</TableCell>
                <TableCell>IP Address</TableCell>
                <TableCell>Hostname</TableCell>
                <TableCell>Subnet</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Detail</TableCell>
                <TableCell>Last Seen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map(item => (
                <TableRow key={`${item.category}-${item.address.id}`} hover>
                  <TableCell>
                    <Chip
                      size="small"
                      label={CATEGORY_INFO[item.category].label}
                      color={CATEGORY_COLOR[item.category]}
                    />
                  </TableCell>
                  <TableCell className={classes.mono}>
                    {item.address.ipAddress}
                  </TableCell>
                  <TableCell>{item.address.hostname || '-'}</TableCell>
                  <TableCell className={classes.mono}>
                    {subnetOf(item.address.subnetId)}
                  </TableCell>
                  <TableCell>{item.address.source || '-'}</TableCell>
                  <TableCell>{item.detail}</TableCell>
                  <TableCell>
                    {item.address.lastSeen
                      ? new Date(item.address.lastSeen).toLocaleString()
                      : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Box mt={4}>
        <Box display="flex" alignItems="center" style={{ gap: 16 }}>
          <Typography variant="h6">DNS check</Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={runDnsCheck}
            disabled={dns.running}
          >
            {dns.running ? 'Checking…' : 'Run DNS check'}
          </Button>
          {dns.checkedAt && (
            <Typography variant="caption" color="textSecondary">
              checked {new Date(dns.checkedAt).toLocaleString()}
            </Typography>
          )}
        </Box>
        <Typography variant="body2" color="textSecondary">
          Fully-qualified hostnames must resolve to their address; where an
          address has reverse DNS, it should name the same host.
        </Typography>
        {dns.error && <Alert severity="error">{dns.error}</Alert>}
        {dns.mismatches?.length === 0 && (
          <Alert severity="success">No DNS mismatches.</Alert>
        )}
        {!!dns.mismatches?.length && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>IP Address</TableCell>
                <TableCell>Hostname</TableCell>
                <TableCell>Problem</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dns.mismatches.map(m => (
                <TableRow key={`${m.ip}-${m.problem}`}>
                  <TableCell className={classes.mono}>{m.ip}</TableCell>
                  <TableCell>{m.hostname}</TableCell>
                  <TableCell>{m.problem}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>
    </Box>
  );
};
