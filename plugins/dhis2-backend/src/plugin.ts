import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import * as os from 'os';
import * as path from 'path';
import { statSync } from 'fs';
import { createRouter } from './service/router';
import {
  OrchestratorConfig,
  ProvisionService,
} from './service/provisionService';

/**
 * When the Backstage backend IS the orchestrator host (host=localhost), pick
 * sensible defaults so a single-server install Just Works without anyone
 * having to set DHIS2_ORCHESTRATOR_* env vars.
 */
function defaultUser(): string {
  try {
    return os.userInfo().username || 'root';
  } catch {
    return 'root';
  }
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultPrivateKey(): string | undefined {
  const home = os.homedir();
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const candidate = path.join(home, '.ssh', name);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

function defaultScriptPath(): string | undefined {
  // Common deployment layouts where the plugin's scripts/ directory ships
  // alongside the backend bundle.
  const candidates = [
    '/opt/backstage/plugins/dhis2/scripts/provision-instance.sh',
    '/opt/dhis2-backstage/plugins/dhis2/scripts/provision-instance.sh',
    path.resolve(
      process.cwd(),
      'plugins/dhis2/scripts/provision-instance.sh',
    ),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

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
          // Pull the sub-config if present, but never *require* it: a single-
          // server install with the plugin scripts deployed alongside should
          // boot with usable defaults (localhost SSH, current user, ~/.ssh
          // key, bundled provision-instance.sh).
          const sub = config.getOptionalConfig('dhis2.orchestrator');
          const host = (sub?.getOptionalString('host') ?? 'localhost').trim();
          const port = sub?.getOptionalNumber('port') ?? 22;

          // Apply same-server defaults only when host is localhost — for a
          // remote orchestrator the operator must supply real credentials.
          const isLocal =
            host === 'localhost' || host === '127.0.0.1' || host === '::1';

          const configuredUser = (sub?.getOptionalString('user') ?? '').trim();
          const configuredKey = (
            sub?.getOptionalString('privateKeyFile') ?? ''
          ).trim();
          const configuredScript = (
            sub?.getOptionalString('scriptPath') ?? ''
          ).trim();

          const user =
            configuredUser || (isLocal ? defaultUser() : '');
          const privateKeyFile =
            configuredKey || (isLocal ? defaultPrivateKey() ?? '' : '');
          const scriptPath =
            configuredScript || (isLocal ? defaultScriptPath() ?? '' : '');

          const missing: string[] = [];
          if (!user) missing.push('user');
          if (!privateKeyFile) missing.push('privateKeyFile');
          if (!scriptPath) missing.push('scriptPath');

          if (missing.length > 0) {
            logger.warn(
              `DHIS2: orchestrator not fully configured (missing: ${missing.join(
                ', ',
              )}). Host=${host}. Create Instance will return 503 until these are set — provide them in app-config.yaml under dhis2.orchestrator or via DHIS2_ORCHESTRATOR_* env vars.`,
            );
          } else {
            orchestrator = {
              host,
              port,
              user,
              privateKeyFile,
              passphrase: sub?.getOptionalString('passphrase'),
              scriptPath,
              stateFile: sub?.getOptionalString('stateFile'),
              skipCertbot: sub?.getOptionalBoolean('skipCertbot') ?? false,
            };
            const usingDefaults: string[] = [];
            if (!configuredUser) usingDefaults.push('user');
            if (!configuredKey) usingDefaults.push('privateKeyFile');
            if (!configuredScript) usingDefaults.push('scriptPath');
            const defaultsNote = usingDefaults.length
              ? ` (defaulted: ${usingDefaults.join(', ')})`
              : '';
            logger.info(
              `DHIS2: orchestrator configured (${orchestrator.user}@${orchestrator.host}:${orchestrator.port}, script=${orchestrator.scriptPath})${defaultsNote}`,
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
