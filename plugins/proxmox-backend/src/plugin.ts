import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { proxmoxPermissions } from '@internal/plugin-proxmox-common';
import { createProxmoxClient } from './proxmoxClient';
import { createRouter } from './router';

/**
 * Backend for the Proxmox monitoring plugin: a read-only, permission-aware
 * gateway to a Proxmox VE cluster's `/cluster/resources`, with health checks
 * in the spirit of Pulse (https://github.com/rcourtman/pulse).
 * Configured under `proxmox.*` (see config.d.ts).
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
        permissionsRegistry: coreServices.permissionsRegistry,
      },
      async init({
        logger,
        config,
        httpRouter,
        httpAuth,
        permissionsRegistry,
      }) {
        permissionsRegistry.addPermissions(proxmoxPermissions);

        const url = config.getOptionalString('proxmox.url');
        const token = config.getOptionalString('proxmox.token');
        if (!url || !token) {
          logger.warn(
            'proxmox: proxmox.url/token not configured; the Proxmox page will show an error',
          );
        }
        const client =
          url && token
            ? createProxmoxClient({
                url,
                token,
                verifyTls:
                  config.getOptionalBoolean('proxmox.verifyTls') ?? true,
              })
            : undefined;

        const att = config.getOptionalConfig('proxmox.attention');

        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
            client,
            uiUrls:
              config.getOptional<Record<string, string>>('proxmox.uiUrls') ??
              {},
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
        logger.info('proxmox: backend initialised');
      },
    });
  },
});
