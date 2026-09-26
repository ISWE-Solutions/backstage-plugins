import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { ipamPermissions } from '@internal/plugin-ipam-common';
import { createPhpIpamClient } from './phpipamClient';
import { createRouter } from './router';

/**
 * Backend for the IPAM plugin: a permission-checked gateway to phpIPAM
 * (LXC 116). Replaces the plain /api/proxy/phpipam route so that creating
 * addresses and subnets needs the ipam.*.create permissions, not just a
 * Backstage session. See docs/infrastructure/ipam.
 */
export const ipamBackend = createBackendPlugin({
  pluginId: 'ipam',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
      },
      async init({
        logger,
        config,
        httpRouter,
        httpAuth,
        permissions,
        permissionsRegistry,
      }) {
        permissionsRegistry.addPermissions(ipamPermissions);

        const url = config.getOptionalString('ipam.phpipam.url');
        const appCode = config.getOptionalString('ipam.phpipam.appCode');
        if (!url || !appCode) {
          logger.warn(
            'ipam: ipam.phpipam.url/appCode not configured; the IPAM page will show an error',
          );
        }
        const phpipam = createPhpIpamClient({
          url: url ?? 'http://phpipam.invalid/',
          appCode: appCode ?? '',
          verifyTls:
            config.getOptionalBoolean('ipam.phpipam.verifyTls') ?? true,
        });

        httpRouter.use(
          await createRouter({ logger, httpAuth, permissions, phpipam }),
        );
      },
    });
  },
});
