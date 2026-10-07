import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  Chip,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@material-ui/core';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { ipamApiRef } from '../../services/ipamService';
import { IPAddress } from '../../types';

/** Comma-separated hostnames to look up instead of the entity name */
export const IPAM_HOSTNAMES_ANNOTATION = 'ipam.iswesolutions.com/hostnames';

export function entityHostnames(entity: {
  metadata: { name: string; annotations?: Record<string, string> };
}): string[] {
  const annotated = entity.metadata.annotations?.[IPAM_HOSTNAMES_ANNOTATION];
  const names = annotated ? annotated.split(',') : [entity.metadata.name];
  return names.map(n => n.trim().toLowerCase()).filter(Boolean);
}

/**
 * IP addresses recorded in IPAM for this entity's host(s). Renders nothing
 * when no address matches, so it can sit on every entity page.
 */
export const EntityIpamCard = () => {
  const { entity } = useEntity();
  const ipamService = useApi(ipamApiRef);
  const [addresses, setAddresses] = useState<IPAddress[]>();
  const hostnames = entityHostnames(entity);
  const key = hostnames.join(',');

  useEffect(() => {
    const wanted = key.split(',');
    ipamService
      .getIPAddresses()
      .then(r =>
        setAddresses(
          r.addresses.filter(a => {
            const h = (a.hostname ?? '').toLowerCase();
            return wanted.includes(h) || wanted.includes(h.split('.')[0]);
          }),
        ),
      )
      .catch(() => setAddresses([]));
  }, [ipamService, key]);

  if (!addresses?.length) return null;
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          IP addresses
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Address</TableCell>
              <TableCell>Hostname</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Source</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {addresses.map(a => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link
                    href={`/ipam?tab=addresses&q=${encodeURIComponent(
                      a.ipAddress,
                    )}`}
                  >
                    <code>{a.ipAddress}</code>
                  </Link>
                </TableCell>
                <TableCell>{a.hostname}</TableCell>
                <TableCell>
                  <Chip size="small" label={a.status} />
                </TableCell>
                <TableCell>{a.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};
