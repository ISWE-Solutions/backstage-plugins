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
        try {
          const sub = config.getOptionalConfig('dhis2.orchestrator');
          if (sub) {
            // Use optional reads so missing env-var substitutions (or empty
            // values) do NOT throw out of init() — a throw here would leave
            // the plugin permanently pending and every request would return
            // HTTP 503 "Service has not started up yet". Validate after the
            // reads and fall back to "not configured" mode instead.
            const user = (sub.getOptionalString('user') ?? '').trim();
            const privateKeyFile = (
              sub.getOptionalString('privateKeyFile') ?? ''
            ).trim();
            const scriptPath = (sub.getOptionalString('scriptPath') ?? '').trim();
            const missing: string[] = [];
            if (!user) missing.push('user');
            if (!privateKeyFile) missing.push('privateKeyFile');
            if (!scriptPath) missing.push('scriptPath');
            if (missing.length > 0) {
              logger.warn(
                `DHIS2: dhis2.orchestrator is present but missing required field(s): ${missing.join(
                  ', ',
                )}. Create Instance will return 503 until these are set (check DHIS2_ORCHESTRATOR_* env vars).`,
              );
            } else {
              orchestrator = {
                host: sub.getOptionalString('host') ?? 'localhost',
                port: sub.getOptionalNumber('port') ?? 22,
                user,
                privateKeyFile,
                passphrase: sub.getOptionalString('passphrase'),
                scriptPath,
                stateFile: sub.getOptionalString('stateFile'),
                skipCertbot: sub.getOptionalBoolean('skipCertbot') ?? false,
              };
              logger.info(
                `DHIS2: orchestrator configured (${orchestrator.user}@${orchestrator.host}:${orchestrator.port}, script=${orchestrator.scriptPath})`,
              );
            }
          } else {
            logger.warn(
              'DHIS2: dhis2.orchestrator not configured — Create Instance will return 503.',
            );
          }
        } catch (err) {
          // Last-resort guard: never let a config-read error block plugin
          // startup. The plugin will come up in "not configured" mode and
          // the router will return a clear 503 with a useful message.
          logger.error(
            `DHIS2: failed to read dhis2.orchestrator config: ${
              err instanceof Error ? err.message : String(err)
            }. Starting plugin without orchestrator support.`,
          );
          orchestrator = null;
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
