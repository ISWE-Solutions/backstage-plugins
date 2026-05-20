import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import {
  OrchestratorConfig,
  ProvisionService,
} from './service/provisionService';

/**
 * Backend plugin for the DHIS2 frontend plugin.
 *
 * Exposes a small HTTP API used by the Create Instance dialog to test
 * PostgreSQL connectivity, list databases, and provision new DHIS2
 * instances by invoking the bundled provision-instance.sh orchestrator
 * over SSH on a Proxmox node.
 */
export const dhis2Plugin = createBackendPlugin({
  pluginId: 'dhis2',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
      },
      async init({ logger, config, httpRouter, httpAuth }) {
        let orchestrator: OrchestratorConfig | null = null;
        const sub = config.getOptionalConfig('dhis2.orchestrator');
        if (sub) {
          orchestrator = {
            host: sub.getOptionalString('host') ?? 'localhost',
            port: sub.getOptionalNumber('port') ?? 22,
            user: sub.getString('user'),
            privateKeyFile: sub.getString('privateKeyFile'),
            passphrase: sub.getOptionalString('passphrase'),
            scriptPath: sub.getString('scriptPath'),
            stateFile: sub.getOptionalString('stateFile'),
            skipCertbot: sub.getOptionalBoolean('skipCertbot') ?? false,
          };
          logger.info(
            `DHIS2: orchestrator configured (${orchestrator.user}@${orchestrator.host}:${orchestrator.port}, script=${orchestrator.scriptPath})`,
          );
        } else {
          logger.warn(
            'DHIS2: dhis2.orchestrator not configured — Create Instance will return 503.',
          );
        }
        const provisionService = new ProvisionService(logger, orchestrator);
        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
            provisionService,
          }),
        );
      },
    });
  },
});
