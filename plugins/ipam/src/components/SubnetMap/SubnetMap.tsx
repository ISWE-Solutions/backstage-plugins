import { Box, Tooltip, Typography } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { IPAddress, IPStatus, Subnet } from '../../types';

const toInt = (ip: string) =>
  ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
const toIp = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

export const MAX_MAP_HOSTS = 1024;

const COLORS: Record<string, string> = {
  [IPStatus.ALLOCATED]: '#2e7d32',
  [IPStatus.RESERVED]: '#1565c0',
  [IPStatus.OFFLINE]: '#c62828',
  [IPStatus.DHCP]: '#9e9e9e',
  free: '#e8f5e9',
  dhcpFree: '#eeeeee',
};
const LEGEND: [string, string][] = [
  [IPStatus.ALLOCATED, 'Used'],
  [IPStatus.RESERVED, 'Reserved'],
  [IPStatus.OFFLINE, 'Offline'],
  [IPStatus.DHCP, 'DHCP lease'],
  ['dhcpFree', 'Free (DHCP pool)'],
  ['free', 'Free'],
];

const useStyles = makeStyles(theme => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(16, 20px)',
    gap: 2,
  },
  cell: {
    width: 20,
    height: 20,
    borderRadius: 2,
    border: `1px solid ${theme.palette.divider}`,
    cursor: 'default',
  },
  clickable: {
    cursor: 'pointer',
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 2,
    display: 'inline-block',
    marginRight: 4,
    border: `1px solid ${theme.palette.divider}`,
  },
}));

interface Props {
  subnet: Subnet;
  addresses: IPAddress[];
  dhcpRanges: { from: string; to: string }[];
  onSelect?: (address: IPAddress) => void;
}

/** One cell per host address in the subnet, coloured by status */
export const SubnetMap = ({
  subnet,
  addresses,
  dhcpRanges,
  onSelect,
}: Props) => {
  const classes = useStyles();
  const size = 2 ** (32 - subnet.cidr);
  if (subnet.cidr > 30 || size > MAX_MAP_HOSTS + 2) {
    return (
      <Typography variant="body2" color="textSecondary">
        The map is available for subnets from /22 to /30.
      </Typography>
    );
  }
  const network = toInt(subnet.network);
  const byIp = new Map(addresses.map(a => [a.ipAddress, a]));
  const pools = dhcpRanges.map(r => [toInt(r.from), toInt(r.to)]);
  const cells = [];
  for (let n = network + 1; n < network + size - 1; n++) {
    const ip = toIp(n);
    const a = byIp.get(ip);
    const inPool = pools.some(([lo, hi]) => n >= lo && n <= hi);
    let key: string = inPool ? 'dhcpFree' : 'free';
    if (a) key = a.status;
    const label = a
      ? `${ip} — ${a.hostname || 'no hostname'} (${a.status}, ${
          a.source ?? 'manual'
        })`
      : `${ip} — free${inPool ? ' (DHCP pool)' : ''}`;
    cells.push(
      <Tooltip key={ip} title={label}>
        <Box
          className={`${classes.cell} ${
            a && onSelect ? classes.clickable : ''
          }`}
          style={{ backgroundColor: COLORS[key] }}
          aria-label={label}
          role={a && onSelect ? 'button' : 'img'}
          onClick={a && onSelect ? () => onSelect(a) : undefined}
        />
      </Tooltip>,
    );
  }
  const used = addresses.length;
  return (
    <Box>
      <Typography variant="body2" gutterBottom>
        {subnet.network}/{subnet.cidr}: {used} recorded of {size - 2} host
        addresses
      </Typography>
      <Box className={classes.grid}>{cells}</Box>
      <Box className={classes.legend}>
        {LEGEND.map(([key, text]) => (
          <Typography key={key} variant="caption">
            <span
              className={classes.swatch}
              style={{ backgroundColor: COLORS[key] }}
            />
            {text}
          </Typography>
        ))}
      </Box>
    </Box>
  );
};
