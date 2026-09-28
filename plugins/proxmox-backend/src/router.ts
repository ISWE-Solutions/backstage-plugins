import express from 'express';
import Router from 'express-promise-router';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import {
  AttentionThresholds,
  findAttentionItems,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { fetchResources } from './resources';
import { ProxmoxClient } from './proxmoxClient';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  /** Absent when proxmox.url/token are not configured */
  client?: ProxmoxClient;
  uiUrls?: Record<string, string>;
  cacheSeconds?: number;
  thresholds?: Partial<AttentionThresholds>;
}

/**
 * /api/proxmox/... Read-only cluster monitoring for any signed-in user.
 * `/resources` aggregates Proxmox `/cluster/resources`; `/attention` runs the
 * health checks. Results are cached briefly to avoid hammering the PVE API.
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth, client, uiUrls = {}, thresholds = {} } = options;
  const cacheMs = (options.cacheSeconds ?? 15) * 1000;

  let cached: { at: number; value: ProxmoxResources } | undefined;
  let inflight: Promise<ProxmoxResources> | undefined;

  const getResources = async (): Promise<ProxmoxResources> => {
    if (!client) {
      throw Object.assign(new Error('proxmox.url/token not configured'), {
        statusCode: 501,
      });
    }
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    if (!inflight) {
      inflight = fetchResources(client, uiUrls)
        .then(value => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };

  const router = Router();
  router.use(express.json());

  // Every route requires a signed-in caller.
  router.use(async (req, _res, next) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', configured: Boolean(client) });
  });

  router.get('/resources', async (_req, res) => {
    res.json(await getResources());
  });

  router.get('/attention', async (_req, res) => {
    const r = await getResources();
    res.json({
      items: findAttentionItems(r, thresholds),
      generatedAt: r.generatedAt,
    });
  });

  // 501 when the plugin is not configured; 502 for upstream Proxmox errors.
  router.use(
    (
      err: Error & { statusCode?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      // Let the backend's global handler translate auth/permission errors
      // (AuthenticationError -> 401, NotAllowedError -> 403).
      if (
        err.name === 'AuthenticationError' ||
        err.name === 'NotAllowedError'
      ) {
        next(err);
        return;
      }
      const status = err.statusCode ?? 502;
      if (status >= 500 && status !== 501) {
        logger.warn(`proxmox: ${err.message}`);
      }
      res.status(status).json({ error: err.message });
    },
  );

  return router;
}
