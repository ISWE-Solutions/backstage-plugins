import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';

/**
 * Backend plugin for the DHIS2 frontend plugin.
 *
 * Exposes a small HTTP API used by the Create Instance dialog to test
 * PostgreSQL connectivity and list databases on an existing server using
 * credentials the user types into the dialog.
 */
export const dhis2Plugin = createBackendPlugin({
  pluginId: 'dhis2',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
      },
      async init({ logger, httpRouter, httpAuth }) {
        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
          }),
        );
      },
    });
  },
});
