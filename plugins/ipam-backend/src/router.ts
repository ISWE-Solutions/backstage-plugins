import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import {
  ipamAddressCreatePermission,
  ipamSubnetCreatePermission,
} from '@internal/plugin-ipam-common';
import { PhpIpamClient } from './phpipamClient';

/** phpIPAM API resources the frontend may read (the app code can reach more) */
// No dots: a segment like ".." would let a crafted path escape to other
// phpIPAM controllers once the URL is normalised.
const READABLE = /^(sections|subnets|addresses|vlan)(\/[A-Za-z0-9_-]+)*\/?$/;

/** Fields accepted when creating records; everything else is dropped */
const ADDRESS_FIELDS = [
  'subnetId',
  'ip',
  'hostname',
  'description',
  'owner',
  'mac',
  'tag',
  'note',
];
const SUBNET_FIELDS = [
  'subnet',
  'mask',
  'sectionId',
  'description',
  'vlanId',
  'pingSubnet',
  'discoverSubnet',
  'scanAgent',
];

const pick = (body: unknown, fields: string[]) =>
  Object.fromEntries(
    Object.entries((body ?? {}) as Record<string, unknown>).filter(
      ([k, v]) =>
        fields.includes(k) && v !== undefined && v !== null && v !== '',
    ),
  );

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  phpipam: PhpIpamClient;
}

/**
 * /api/ipam/phpipam/...  Reads: any signed-in user, limited to READABLE.
 * Writes: POST addresses / subnets, each behind its own permission.
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth, permissions, phpipam } = options;
  const router = Router();
  router.use(express.json({ limit: '100kb' }));

  const requirePermission = async (
    req: express.Request,
    permission: BasicPermission,
  ) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const [decision] = await permissions.authorize([{ permission }], {
      credentials,
    });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Missing permission ${permission.name}`);
    }
    return credentials.principal.userEntityRef;
  };

  router.get('/phpipam/*', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    // wildcard segment of /phpipam/*
    const path = String((req.params as Record<string, string>)['0'] ?? '');
    if (!READABLE.test(path)) {
      res
        .status(404)
        .json({ success: false, message: 'Not available through Backstage' });
      return;
    }
    const query = new URLSearchParams(
      req.query as Record<string, string>,
    ).toString();
    const r = await phpipam.request('GET', query ? `${path}?${query}` : path);
    res.status(r.status).json(r.body);
  });

  router.post('/phpipam/addresses', async (req, res) => {
    const user = await requirePermission(req, ipamAddressCreatePermission);
    const r = await phpipam.request(
      'POST',
      'addresses/',
      pick(req.body, ADDRESS_FIELDS),
    );
    logger.info(
      `ipam: ${user} created address ${req.body?.ip} (phpIPAM ${r.status})`,
    );
    res.status(r.status).json(r.body);
  });

  router.post('/phpipam/subnets', async (req, res) => {
    const user = await requirePermission(req, ipamSubnetCreatePermission);
    const r = await phpipam.request(
      'POST',
      'subnets/',
      pick(req.body, SUBNET_FIELDS),
    );
    logger.info(
      `ipam: ${user} created subnet ${req.body?.subnet}/${req.body?.mask} (phpIPAM ${r.status})`,
    );
    res.status(r.status).json(r.body);
  });

  return router;
}
