import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  AttentionThresholds,
  findAttentionItems,
  proxmoxClusterManagePermission,
  ProxmoxResources,
} from '@iswesolutions/plugin-proxmox-common';
import { fetchResources } from './resources';
import { fetchDisks, fetchSmart } from './disks';
import { createProxmoxClient } from './proxmoxClient';
import { ClusterRegistry } from './clusters';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  registry: ClusterRegistry;
  cacheSeconds?: number;
  thresholds?: Partial<AttentionThresholds>;
}

const clusterInput = (body: any) => ({
  name: String(body?.name ?? '').trim(),
  url: String(body?.url ?? '').trim(),
  token: body?.token ? String(body.token) : undefined,
  verifyTls: Boolean(body?.verifyTls),
  uiUrls:
    body?.uiUrls && typeof body.uiUrls === 'object'
      ? (body.uiUrls as Record<string, string>)
      : {},
});

/**
 * /api/proxmox/... Read-only cluster monitoring for any signed-in user, across
 * one or more configured clusters (?cluster=<id>). Cluster management
 * (/clusters POST/PUT/DELETE) is gated by proxmox.cluster.manage.
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth, permissions, registry, thresholds = {} } = options;
  const cacheMs = (options.cacheSeconds ?? 15) * 1000;

  const cache = new Map<string, { at: number; value: ProxmoxResources }>();
  const inflight = new Map<string, Promise<ProxmoxResources>>();
  // physical disks change rarely; cache longer than resources
  const diskCache = new Map<string, { at: number; value: unknown }>();
  const diskCacheMs = Math.max(cacheMs, 60_000);

  const getResources = async (clusterId: string): Promise<ProxmoxResources> => {
    const cached = cache.get(clusterId);
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    let run = inflight.get(clusterId);
    if (!run) {
      run = (async () => {
        const resolved = await registry.clientFor(clusterId);
        if (!resolved) {
          throw Object.assign(
            new Error(`cluster ${clusterId} not found or has no token`),
            { statusCode: 404 },
          );
        }
        const value = await fetchResources(
          resolved.client,
          resolved.cluster.uiUrls,
        );
        value.clusterId = resolved.cluster.id;
        value.clusterName = resolved.cluster.name;
        cache.set(clusterId, { at: Date.now(), value });
        return value;
      })().finally(() => inflight.delete(clusterId));
      inflight.set(clusterId, run);
    }
    return run;
  };

  const resolveClusterId = async (req: express.Request): Promise<string> => {
    const requested = req.query.cluster ? String(req.query.cluster) : undefined;
    const id = requested ?? (await registry.defaultId());
    if (!id) {
      throw Object.assign(new Error('no Proxmox clusters configured'), {
        statusCode: 501,
      });
    }
    return id;
  };

  const requireManage = async (req: express.Request) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const decision = (
      await permissions.authorize(
        [{ permission: proxmoxClusterManagePermission }],
        { credentials },
      )
    )[0];
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw Object.assign(new Error('not allowed to manage clusters'), {
        name: 'NotAllowedError',
      });
    }
  };

  const router = Router();
  router.use(express.json());

  router.use(async (req, _res, next) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    next();
  });

  router.get('/health', async (_req, res) => {
    const clusters = await registry.list();
    res.json({ status: 'ok', configured: clusters.length > 0 });
  });

  router.get('/clusters', async (_req, res) => {
    res.json({ clusters: await registry.list() });
  });

  router.get('/resources', async (req, res) => {
    res.json(await getResources(await resolveClusterId(req)));
  });

  router.get('/disks', async (req, res) => {
    const clusterId = await resolveClusterId(req);
    const cached = diskCache.get(clusterId);
    if (cached && Date.now() - cached.at < diskCacheMs) {
      res.json({ disks: cached.value });
      return;
    }
    const resolved = await registry.clientFor(clusterId);
    if (!resolved) {
      throw Object.assign(new Error(`cluster ${clusterId} not found`), {
        statusCode: 404,
      });
    }
    const resources = await getResources(clusterId);
    const nodes = resources.nodes
      .filter(n => n.status === 'online')
      .map(n => n.node);
    const disks = await fetchDisks(resolved.client, nodes);
    diskCache.set(clusterId, { at: Date.now(), value: disks });
    res.json({ disks });
  });

  router.get('/disks/smart', async (req, res) => {
    const clusterId = await resolveClusterId(req);
    const node = String(req.query.node ?? '');
    const disk = String(req.query.disk ?? '');
    if (!node || !disk) {
      throw Object.assign(new Error('node and disk are required'), {
        statusCode: 400,
      });
    }
    const resolved = await registry.clientFor(clusterId);
    if (!resolved) {
      throw Object.assign(new Error(`cluster ${clusterId} not found`), {
        statusCode: 404,
      });
    }
    res.json(await fetchSmart(resolved.client, node, disk));
  });

  router.get('/attention', async (req, res) => {
    const r = await getResources(await resolveClusterId(req));
    res.json({
      items: findAttentionItems(r, thresholds),
      generatedAt: r.generatedAt,
      clusterId: r.clusterId,
      clusterName: r.clusterName,
    });
  });

  // --- cluster management (proxmox.cluster.manage) ---

  router.post('/clusters', async (req, res) => {
    await requireManage(req);
    const input = clusterInput(req.body);
    if (!input.name || !input.url || !input.token) {
      throw Object.assign(new Error('name, url and token are required'), {
        statusCode: 400,
      });
    }
    res.status(201).json(await registry.add(input));
  });

  router.put('/clusters/:id', async (req, res) => {
    await requireManage(req);
    const input = clusterInput(req.body);
    if (!input.name || !input.url) {
      throw Object.assign(new Error('name and url are required'), {
        statusCode: 400,
      });
    }
    const updated = await registry.update(req.params.id, input);
    if (!updated) {
      throw Object.assign(new Error('cluster not found'), { statusCode: 404 });
    }
    cache.delete(req.params.id);
    res.json(updated);
  });

  router.delete('/clusters/:id', async (req, res) => {
    await requireManage(req);
    const ok = await registry.remove(req.params.id);
    if (!ok) {
      throw Object.assign(new Error('cluster not found'), { statusCode: 404 });
    }
    cache.delete(req.params.id);
    res.status(204).end();
  });

  // Test a connection: either ad-hoc creds in the body, or an existing cluster id.
  router.post('/clusters/test', async (req, res) => {
    await requireManage(req);
    let url: string;
    let token: string;
    let verifyTls: boolean;
    if (req.body?.id) {
      const resolved = await registry.resolve(String(req.body.id));
      if (!resolved) {
        throw Object.assign(new Error('cluster not found'), {
          statusCode: 404,
        });
      }
      ({ url, token, verifyTls } = resolved);
    } else {
      const input = clusterInput(req.body);
      if (!input.url || !input.token) {
        throw Object.assign(new Error('url and token are required'), {
          statusCode: 400,
        });
      }
      url = input.url;
      token = input.token;
      verifyTls = input.verifyTls;
    }
    try {
      const r = await fetchResources(
        createProxmoxClient({ url, token, verifyTls }),
      );
      res.json({
        ok: true,
        nodes: r.nodes.length,
        guests: r.guests.length,
        message: `Connected — ${r.nodes.length} node(s)`,
      });
    } catch (e) {
      res.json({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  router.use(
    (
      err: Error & { statusCode?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        err.name === 'AuthenticationError' ||
        err.name === 'NotAllowedError'
      ) {
        next(err);
        return;
      }
      const status = err.statusCode ?? 502;
      if (status >= 500 && status !== 501)
        logger.warn(`proxmox: ${err.message}`);
      res.status(status).json({ error: err.message });
    },
  );

  return router;
}
