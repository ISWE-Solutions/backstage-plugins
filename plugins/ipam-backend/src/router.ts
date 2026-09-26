import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import {
  ipamAddressCreatePermission,
  ipamSubnetCreatePermission,
} from '@internal/plugin-ipam-common';
import { PhpIpamClient } from './phpipamClient';
import { AllocationService } from './allocation';

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
  /** Absent when ipam.allocation is not configured */
  allocations?: AllocationService;
}

/**
 * /api/ipam/phpipam/...  Reads: any signed-in user, limited to READABLE.
 * Writes: POST addresses / subnets, each behind its own permission.
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth, permissions, phpipam, allocations } = options;
  const router = Router();
  router.use(express.json({ limit: '100kb' }));

  /**
   * Users need the permission; backend plugins (service principals, e.g. the
   * DHIS2 provisioner) are trusted by the permission framework.
   */
  const requirePermission = async (
    req: express.Request,
    permission: BasicPermission,
    allowServices = false,
  ): Promise<string> => {
    const credentials = await httpAuth.credentials(req, {
      allow: allowServices ? ['user', 'service'] : ['user'],
    });
    const [decision] = await permissions.authorize([{ permission }], {
      credentials,
    });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Missing permission ${permission.name}`);
    }
    const principal = credentials.principal as {
      type: string;
      userEntityRef?: string;
      subject?: string;
    };
    return (
      principal.userEntityRef ?? `service:${principal.subject ?? 'unknown'}`
    );
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

  // ---- allocation of static addresses (see ./allocation.ts) ----

  const HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/;
  const requireAllocations = () => {
    if (!allocations) {
      throw new NotFoundError(
        'Address allocation is not configured (ipam.allocation)',
      );
    }
    return allocations;
  };

  router.get('/allocations/pool', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    res.json(requireAllocations().pool);
  });

  router.post('/allocations', async (req, res) => {
    const caller = await requirePermission(
      req,
      ipamAddressCreatePermission,
      true,
    );
    const service = requireAllocations();
    const hostname = String(req.body?.hostname ?? '').trim();
    const purpose = String(req.body?.purpose ?? '').trim();
    if (!HOSTNAME.test(hostname)) throw new InputError('hostname is invalid');
    if (!purpose || purpose.length > 200) {
      throw new InputError('purpose is required (max 200 characters)');
    }
    // a backend plugin may say which user it is acting for; a user may not
    const requestedBy =
      caller.startsWith('service:') && typeof req.body?.requestedBy === 'string'
        ? `${req.body.requestedBy} via ${caller.slice('service:'.length)}`
        : caller;
    const allocation = await service.allocate({
      hostname,
      purpose,
      requestedBy,
    });
    res.status(201).json(allocation);
  });

  router.post('/allocations/:id/confirm', async (req, res) => {
    await requirePermission(req, ipamAddressCreatePermission, true);
    await requireAllocations().confirm(req.params.id, {
      hostname: req.body?.hostname,
      description: req.body?.description,
    });
    res.status(204).end();
  });

  router.delete('/allocations/:id', async (req, res) => {
    await requirePermission(req, ipamAddressCreatePermission, true);
    await requireAllocations().release(req.params.id);
    res.status(204).end();
  });

  return router;
}
