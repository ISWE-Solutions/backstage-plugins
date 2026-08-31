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
  normalizeProxmoxCreds,
} from './service/provisionService';
import { DatabaseTransferService } from './service/databaseTransferService';
import { InstanceRegistryService } from './service/instanceRegistryService';
import { InstanceStore } from './service/instanceStore';

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
  // Prefer keys that have a sibling `.pub`, because the orchestrator script
  // copies the public half into the new LXC's authorized_keys.
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const candidate = path.join(home, '.ssh', name);
    if (fileExists(candidate) && fileExists(`${candidate}.pub`)) {
      return candidate;
    }
  }
  // Fall back to a key without a .pub (still useful for SSH auth itself).
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
    '/opt/backstage/plugins/dhis2/scripts/create-instance.sh',
    '/opt/dhis2-backstage/plugins/dhis2/scripts/create-instance.sh',
    path.resolve(process.cwd(), 'plugins/dhis2/scripts/create-instance.sh'),
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
        database: coreServices.database,
        scheduler: coreServices.scheduler,
      },
      async init({
        logger,
        config,
        httpRouter,
        httpAuth,
        database,
        scheduler,
      }) {
        let orchestrator: OrchestratorConfig | null = null;
        try {
          // Pull the sub-config if present, but never *require* it: a single-
          // server install with the plugin scripts deployed alongside should
          // boot with usable defaults (localhost SSH, current user, ~/.ssh
          // key, bundled create-instance.sh).
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

          const user = configuredUser || (isLocal ? defaultUser() : '');
          const privateKeyFile =
            configuredKey || (isLocal ? defaultPrivateKey() ?? '' : '');
          const scriptPath =
            configuredScript || (isLocal ? defaultScriptPath() ?? '' : '');

          const missing: string[] = [];
          if (!user) missing.push('user');
          // SSH private key is only needed when we'll actually open an SSH
          // connection — for a local orchestrator we exec the script directly.
          if (!isLocal && !privateKeyFile) missing.push('privateKeyFile');
          if (!scriptPath) missing.push('scriptPath');
          if (scriptPath && !fileExists(scriptPath)) {
            missing.push(`scriptPath (file not found: ${scriptPath})`);
          }

          // Proxmox REST API credentials. These are required at runtime
          // (the pve_lxc Ansible role drives the API to create the LXC)
          // but we do NOT block plugin initialization on them: the orchestrator
          // can still be used for non-provisioning operations (DB tests, etc.)
          // and the bash script itself fails fast with a clear error if the
          // PROXMOX_API_* env vars are unset when a provision is attempted.
          const apiUrl = (sub?.getOptionalString('apiUrl') ?? '').trim();
          const rawApiUser = (sub?.getOptionalString('apiUser') ?? '').trim();
          const rawApiTokenId = (
            sub?.getOptionalString('apiTokenId') ?? ''
          ).trim();
          // Accept either canonical form (`apiUser=root@pam`,
          // `apiTokenId=backstage`) or the full token id pasted as
          // `apiTokenId=root@pam!backstage` — matching what the Proxmox UI
          // shows and what the frontend ProxmoxClusterPanel stores.
          const { apiUser, apiTokenId } = normalizeProxmoxCreds(
            rawApiUser,
            rawApiTokenId,
          );
          const apiTokenSecret = (
            sub?.getOptionalString('apiTokenSecret') ?? ''
          ).trim();
          const validateApiCerts =
            sub?.getOptionalBoolean('validateApiCerts') ?? false;
          const missingApi: string[] = [];
          if (!apiUrl) missingApi.push('apiUrl');
          if (!apiUser) missingApi.push('apiUser');
          if (!apiTokenId) missingApi.push('apiTokenId');
          if (!apiTokenSecret) missingApi.push('apiTokenSecret');
          if (missingApi.length > 0) {
            logger.warn(
              `DHIS2: Proxmox API credentials not set (missing: ${missingApi.join(
                ', ',
              )}). Provisioning will fail at runtime until these are provided via dhis2.orchestrator.{apiUrl,apiUser,apiTokenId,apiTokenSecret} or the PROXMOX_API_URL/PROXMOX_USER/PROXMOX_TOKEN_ID/PROXMOX_TOKEN_SECRET env vars.`,
            );
          }

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
              // Optional explicit override of the Proxmox node the
              // host-proxy step SSHes to. When undefined, the script
              // falls back to host (if non-local) or the per-request node.
              pveHost: sub?.getOptionalString('pveHost'),
              stateFile: sub?.getOptionalString('stateFile'),
              skipCertbot: sub?.getOptionalBoolean('skipCertbot') ?? false,
              apiUrl,
              apiUser,
              apiTokenId,
              apiTokenSecret,
              validateApiCerts,
              restoreStagingDir:
                sub?.getOptionalString('restoreStagingDir') || undefined,
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
        const db = await database.getClient();
        const instanceStore = new InstanceStore(db, logger);
        await instanceStore.init();
        const provisionService = new ProvisionService(
          logger,
          orchestrator,
          instanceStore,
        );
        await provisionService.importLegacyStateFile();

        // Automatic live-state reconciliation: without this, `resources`,
        // `version`, `tomcatVersion`, and `database` connection details are
        // only ever written when the plugin itself performs an action, and
        // silently go stale the moment someone changes the real instance
        // out-of-band (resizing the LXC, upgrading DHIS2 by hand, rotating
        // a DB password directly). See `reconcileAllLiveState` for what's
        // actually checked. Runs only when the orchestrator is configured —
        // there's nothing to reconcile against otherwise.
        if (orchestrator) {
          await scheduler.scheduleTask({
            id: 'dhis2-reconcile-live-state',
            frequency: { minutes: 30 },
            timeout: { minutes: 10 },
            initialDelay: { minutes: 2 },
            fn: async () => {
              const results = await provisionService.reconcileAllLiveState();
              const drifted = results.filter(
                r => Object.keys(r.changes).length > 0,
              );
              const errored = results.filter(r => r.errors.length > 0);
              // Per-instance detail for errors — the summary line alone
              // doesn't say *which* instance or *why*, and this task runs
              // unattended every 30 minutes with nobody watching by default.
              for (const r of errored) {
                logger.warn(
                  `DHIS2: live-state probe errors for ${r.name} (${
                    r.instanceId
                  }): ${r.errors.join('; ')}`,
                );
              }
              if (drifted.length > 0 || errored.length > 0) {
                logger.info(
                  `DHIS2: live-state reconciliation checked ${results.length} instance(s) — ${drifted.length} updated, ${errored.length} had probe errors`,
                );
              }
            },
          });
        }

        const databaseTransferService = new DatabaseTransferService(
          logger,
          provisionService,
        );
        const instanceRegistryService = new InstanceRegistryService(
          logger,
          provisionService,
        );
        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
            provisionService,
            databaseTransferService,
            instanceRegistryService,
          }),
        );
      },
    });
  },
});
