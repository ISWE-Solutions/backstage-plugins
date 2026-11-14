import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { monitoringPermissions } from './settings';
import { createSettingsStore } from './store';

/**
 * Backend for @iswesolutions/plugin-monitoring: the shared settings edited on its Settings tab
 * (cost rates, electricity tariff ...), kept in Backstage's database. Changing them needs
 * monitoring.settings.update.
 */
export const monitoringBackend = createBackendPlugin({
  pluginId: 'monitoring',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        database: coreServices.database,
      },
      async init({
        logger,
        httpRouter,
        httpAuth,
        permissions,
        permissionsRegistry,
        database,
      }) {
        permissionsRegistry.addPermissions(monitoringPermissions);
        const store = await createSettingsStore(database);
        httpRouter.use(
          await createRouter({ logger, httpAuth, permissions, store }),
        );
        logger.info('monitoring: settings backend initialised');
      },
    });
  },
});
