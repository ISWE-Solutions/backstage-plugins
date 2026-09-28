import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { proxmoxPermissions } from '@internal/plugin-proxmox-common';
import { createRouter } from './router';
import { createClusterStore } from './clusterStore';
import { ConfigCluster, createClusterRegistry } from './clusters';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'cluster';

/**
 * Backend for the Proxmox monitoring plugin: a read-only, permission-aware
 * gateway to one or more Proxmox VE clusters. Clusters come from app-config
 * (read-only) and from the database (added via the Settings tab, gated by
 * proxmox.cluster.manage). Health checks follow Pulse's "Patrol" spirit.
 */
export const proxmoxBackend = createBackendPlugin({
  pluginId: 'proxmox',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        database: coreServices.database,
      },
      async init({
        logger,
        config,
        httpRouter,
        httpAuth,
        permissions,
        permissionsRegistry,
        database,
      }) {
        permissionsRegistry.addPermissions(proxmoxPermissions);

        const configClusters: ConfigCluster[] = [];
        const seenIds = new Set<string>();
        const pushCluster = (
          c: Omit<ConfigCluster, 'id'> & { id?: string },
        ) => {
          let id = c.id ?? `config:${slug(c.name)}`;
          while (seenIds.has(id)) id = `${id}-x`;
          seenIds.add(id);
          configClusters.push({ ...c, id });
        };

        // Legacy single-cluster config (proxmox.url/token)
        const url = config.getOptionalString('proxmox.url');
        const token = config.getOptionalString('proxmox.token');
        if (url && token) {
          pushCluster({
            name: config.getOptionalString('proxmox.name') ?? 'default',
            url,
            token,
            verifyTls: config.getOptionalBoolean('proxmox.verifyTls') ?? true,
            uiUrls:
              config.getOptional<Record<string, string>>('proxmox.uiUrls') ??
              {},
          });
        }

        // Additional clusters (proxmox.clusters[])
        for (const c of config.getOptionalConfigArray('proxmox.clusters') ??
          []) {
          pushCluster({
            name: c.getString('name'),
            url: c.getString('url'),
            token: c.getString('token'),
            verifyTls: c.getOptionalBoolean('verifyTls') ?? true,
            uiUrls: c.getOptional<Record<string, string>>('uiUrls') ?? {},
          });
        }

        const store = await createClusterStore(database).catch(err => {
          logger.warn(`proxmox: cluster database unavailable: ${err}`);
          return undefined;
        });

        const registry = createClusterRegistry({ configClusters, store });

        const total =
          configClusters.length + (store ? (await store.list()).length : 0);
        if (total === 0) {
          logger.warn(
            'proxmox: no clusters configured (app-config or Settings tab); the Proxmox page will show an error until one is added',
          );
        }

        const att = config.getOptionalConfig('proxmox.attention');

        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
            permissions,
            registry,
            cacheSeconds: config.getOptionalNumber('proxmox.cacheSeconds'),
            thresholds: {
              ...(att?.getOptionalNumber('storageFull') !== undefined
                ? { storageFull: att!.getNumber('storageFull') }
                : {}),
              ...(att?.getOptionalNumber('nodeMemoryHigh') !== undefined
                ? { nodeMemoryHigh: att!.getNumber('nodeMemoryHigh') }
                : {}),
              ...(att?.getOptionalNumber('guestMemoryHigh') !== undefined
                ? { guestMemoryHigh: att!.getNumber('guestMemoryHigh') }
                : {}),
            },
          }),
        );
        logger.info(`proxmox: backend initialised (${total} cluster(s))`);
      },
    });
  },
});
