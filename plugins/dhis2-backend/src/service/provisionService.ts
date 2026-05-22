import { LoggerService } from '@backstage/backend-plugin-api';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID, randomBytes } from 'crypto';
import {
  DHIS2_TAGS,
  ProxmoxApiCredentials,
  ensureLxcTags,
} from './proxmoxApi';
import { InstanceStore } from './instanceStore';

/**
 * Configuration for the host that runs provision-instance.sh.
 *
 * In the API-based flow this host is the Backstage backend itself: the
 * script renders an Ansible playbook that drives Proxmox via the REST API
 * (community.general.proxmox) — no `pct`/`pvesh` CLI is required and the
 * Backstage host does NOT need to be a Proxmox node.
 *
 * The legacy `host` / `user` / `privateKeyFile` fields are still consumed
 * by configure-host-proxy.sh (which SSHes to the PVE host to install the
 * central Nginx + Let's Encrypt cert).
 */
export interface OrchestratorConfig {
  host: string;
  port: number;
  user: string;
  /** Absolute path on the Backstage backend host to the SSH private key. */
  privateKeyFile: string;
  /** Optional passphrase for the private key. */
  passphrase?: string;
  /**
   * Absolute path on the orchestrator host to provision-instance.sh, e.g.
   * /opt/dhis2-backstage/plugins/dhis2/scripts/provision-instance.sh
   */
  scriptPath: string;
  /**
   * Explicit Proxmox node to SSH to for the central Nginx step (used by
   * configure-host-proxy.sh). When omitted, falls back to host (if
   * non-local) and then to the per-request node.
   */
  pveHost?: string;
  /**
   * Optional path on the Backstage backend host where successfully
   * provisioned instances are appended as JSON. When omitted, no list is
   * persisted (the frontend will only see live jobs).
   */
  stateFile?: string;
  /** Skip Let's Encrypt cert request (passes --skip-certbot to the script). */
  skipCertbot?: boolean;

  // ---- Proxmox REST API (consumed by the pve_lxc Ansible role) ----
  /** Proxmox API base URL, e.g. "https://pve01:8006". */
  apiUrl: string;
  /** Proxmox API user, e.g. "root@pam". */
  apiUser: string;
  /** Proxmox API token id (the part after `!`). */
  apiTokenId: string;
  /** Proxmox API token secret (UUID). */
  apiTokenSecret: string;
  /** Validate the Proxmox API TLS cert. Default: false. */
  validateApiCerts?: boolean;
}

export type JobStatus = 'queued' | 'running' | 'success' | 'failed';

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  exitCode?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** Sanitized log lines (secrets are NEVER written to this list). */
  lines: string[];
  /** Echo of the request payload (minus secrets) for the UI. */
  request: SafeRequestEcho;
  /** Populated on success — the persisted instance record. */
  instance?: PersistedInstance;
}

export interface PersistedInstance {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error';
  version: string;
  url: string;
  domain: string;
  database: {
    name: string;
    user: string;
    host?: string;
    port?: number;
    password?: string;
    existing?: boolean;
  };
  resources: { cpu: number; memory: number; storage: number };
  tomcatVersion?: string;
  proxyOverride?: {
    mode?: string;
    baseDomain?: string;
    pathPrefix?: string;
  };
  restore?: Record<string, unknown>;
  proxySettings?: {
    mode?: string;
    baseDomain?: string;
    pathPrefix?: string;
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
    sslProvider?: string;
    letsencryptEmail?: string;
    sslCertPath?: string;
    sslKeyPath?: string;
    forceHttps?: boolean;
    enableHsts?: boolean;
    upstreamPort?: number;
  };
  dhis2Settings?: {
    defaultVersion?: string;
    javaHeap?: string;
    tomcatPort?: number;
    defaultCpu?: number;
    defaultMemoryMb?: number;
    defaultStorageGb?: number;
    postgresHost?: string;
    postgresPort?: number;
    postgresAdminUser?: string;
    backupEnabled?: boolean;
    backupSchedule?: string;
    backupRetentionDays?: number;
    backupBucket?: string;
  };
  created: string;
  updated: string;
}

interface SafeRequestEcho {
  name: string;
  domain: string;
  version: string;
  node: string;
  vmid: number;
}

/** Shape the frontend sends to POST /instances/provision. */
export interface ProvisionRequest {
  name: string;
  domain: string;
  version: string;
  node: string;
  vmid: number;
  hostname: string;
  email: string;
  resources: { cpu: number; memory: number; storage: number };
  database: {
    name: string;
    user: string;
    password: string;
    /**
     * Optional hostname of a shared/external PostgreSQL server. When set,
     * the postgres Ansible role runs from the controller against this host
     * (using the admin credentials below) instead of installing PostgreSQL
     * inside the LXC.
     */
    host?: string;
    /** PostgreSQL port. Defaults to 5432 when `host` is set. */
    port?: number;
    /**
     * When true, the postgres role attaches DHIS2 to an existing database
     * instead of (re)creating it. Combined with `host`, this is the
     * “use-existing” flow from the Create Instance dialog.
     */
    existing?: boolean;
  };
  /**
   * Admin role on the shared PostgreSQL host used to CREATE the per-
   * instance database/user. Only meaningful when `database.host` is set.
   * Defaults to user=“postgres” when host is set but adminUser is empty.
   */
  databaseAdmin?: { user: string; password: string };
  /**
   * Initial DHIS2 admin password. Optional — when omitted or blank, the
   * backend generates a strong random password and emits it once into the
   * job log so the operator can copy it.
   */
  adminPassword?: string;
  rootPassword?: string;
  newDbAccount?: { user: string; password: string };
  skipCertbot?: boolean;
  /**
   * When true, the bash orchestrator first stops + deletes any existing
   * LXC container with the same VMID (and removes its nginx vhost)
   * before invoking the create-LXC step. The frontend gates this behind
   * an explicit confirmation prompt.
   */
  deleteIfExists?: boolean;
  /**
   * Major Apache Tomcat version to install inside the LXC (`'9'` or
   * `'10'`). Forwarded to `provision-instance.sh --tomcat-version` and
   * then to the Ansible `dhis2` role as `tomcat_version`. When omitted
   * the script defaults to `9` (matches DHIS2 2.40/2.41).
   */
  tomcatVersion?: string;
  /** Optional per-instance routing override from Create dialog. */
  proxyOverride?: {
    mode?: string;
    baseDomain?: string;
    pathPrefix?: string;
  };
  /** Optional restore source descriptor for initial data load. */
  restore?: Record<string, unknown>;
  /** Optional reverse-proxy settings snapshot from Create dialog. */
  proxySettings?: {
    mode?: string;
    baseDomain?: string;
    pathPrefix?: string;
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
    sslProvider?: string;
    letsencryptEmail?: string;
    sslCertPath?: string;
    sslKeyPath?: string;
    forceHttps?: boolean;
    enableHsts?: boolean;
    upstreamPort?: number;
  };
  /** Optional DHIS2 defaults snapshot from Create dialog. */
  dhis2Settings?: {
    defaultVersion?: string;
    javaHeap?: string;
    tomcatPort?: number;
    defaultCpu?: number;
    defaultMemoryMb?: number;
    defaultStorageGb?: number;
    postgresHost?: string;
    postgresPort?: number;
    postgresAdminUser?: string;
    postgresAdminPassword?: string;
    backupEnabled?: boolean;
    backupSchedule?: string;
    backupRetentionDays?: number;
    backupBucket?: string;
  };
  /**
   * Optional Proxmox API credentials sent by the frontend (e.g. from the
   * ProxmoxClusterPanel settings). When provided, individual fields
   * override the server-side `dhis2.orchestrator.*` / `PROXMOX_*` config
   * for this job so an operator can re-target a single run without
   * editing app-config / env vars.
   *
   * `apiTokenId` accepts either the full token id (`user@realm!name`)
   * or just the token name — see `normalizeProxmoxCreds`.
   */
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
  /**
   * Optional reverse-proxy server details forwarded from the DHIS2 Reverse
   * Proxy panel (or per-instance overrides on the Create Instance dialog).
   * The Ansible Phase 5 (`roles/proxy`) play SSHes to `host` to write the
   * nginx config + request a Let's Encrypt cert. When omitted, the script
   * falls back to the Proxmox host derived from `PROXMOX_API_URL`, which
   * is the legacy (single-node) behaviour.
   */
  proxy?: {
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
  };
}

/**
 * Shape the frontend sends to POST /instances/:id/decommission.
 *
 * Mirrors the subset of `ProvisionRequest` needed to tear down a
 * previously-provisioned instance. The instance id from the URL is the
 * primary key; the rest of the payload supplies the Proxmox + nginx
 * teardown settings (defaulted from saved global settings in the UI).
 */
export interface DecommissionRequest {
  /** Persisted instance id (e.g. "dhis2-101"). Used to look up + remove from state. */
  instanceId: string;
  vmid: number;
  node: string;
  /** Same form used by provision-instance.sh: '<fqdn>' or '<fqdn>/<segment>'. */
  domain: string;
  /** Human-readable instance name — only used for log lines and the job echo. */
  name: string;
  /** Skip the configure-host-proxy.sh --remove step. */
  skipProxyCleanup?: boolean;
  /** When true, drop the DHIS2 database+role on a shared PostgreSQL host. */
  dropDatabase?: boolean;
  database?: {
    name?: string;
    user?: string;
    host?: string;
    port?: number;
  };
  databaseAdmin?: { user?: string; password?: string };
  proxy?: {
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
  };
  /** Per-job Proxmox credential override (same semantics as ProvisionRequest.proxmox). */
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
}

/**
 * Shape the frontend sends to POST /instances/:id/edit.
 *
 * Mirrors the subset of `ProvisionRequest` that an Edit dialog can
 * legitimately change after the instance exists. The instance id from
 * the URL is the primary key; the rest of the payload feeds the
 * `edit-instance.sh` wrapper which renders extra-vars and runs the
 * Ansible `edit.yml` playbook.
 *
 * Only resources (CPU/memory/storage), the per-instance DB connection
 * fields rendered into `dhis.conf`, and the display `name` are touched
 * by the playbook; `version` is currently a registry-only field
 * (binary upgrade is a separate flow).
 */
export interface EditRequest {
  instanceId: string;
  vmid: number;
  node: string;
  /** Same form used by provision-instance.sh: '<fqdn>' or '<fqdn>/<segment>'. */
  domain: string;
  /** Human-readable instance name — applied to the persisted registry record. */
  name: string;
  /** New DHIS2 version label. Stored in the registry; no WAR redeploy. */
  version: string;
  resources: { cpu: number; memory: number; storage: number };
  database: {
    name: string;
    user: string;
    host?: string;
    port?: number;
    /** Required for re-rendering dhis.conf. */
    password: string;
  };
  /** When false, skip the Tomcat restart after writing dhis.conf. */
  restartTomcat?: boolean;
  proxy?: {
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
  };
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
}

/**
 * Normalize Proxmox API credentials so the orchestrator (and the bash
 * script / Ansible role downstream) always receive `PROXMOX_USER` =
 * `user@realm` and `PROXMOX_TOKEN_ID` = the token name (the part AFTER
 * the `!`).
 *
 * Accepts both formats operators commonly paste from the Proxmox UI:
 *
 *   apiUser="root@pam"            apiTokenId="backstage"
 *   apiUser="root@pam"            apiTokenId="root@pam!backstage"
 *   apiUser=""                    apiTokenId="root@pam!backstage"
 *
 * Returns the canonical pair.
 */
export function normalizeProxmoxCreds(
  apiUser: string | undefined,
  apiTokenId: string | undefined,
): { apiUser: string; apiTokenId: string } {
  const rawUser = (apiUser ?? '').trim();
  const rawToken = (apiTokenId ?? '').trim();
  if (rawToken.includes('!')) {
    const idx = rawToken.indexOf('!');
    const userPart = rawToken.slice(0, idx).trim();
    const tokenPart = rawToken.slice(idx + 1).trim();
    return {
      apiUser: rawUser || userPart,
      apiTokenId: tokenPart,
    };
  }
  return { apiUser: rawUser, apiTokenId: rawToken };
}

/**
 * OpenSSH `-i` requires a private key path. When operators accidentally
 * paste `*.pub`, normalize it to the corresponding private key file.
 */
function normalizeSshPrivateKeyPath(pathLike?: string): string | undefined {
  const trimmed = (pathLike ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('.pub') ? trimmed.slice(0, -4) : trimmed;
}

const MAX_LOG_LINES = 5000;

// In-memory job registry. Single-process Backstage backend — fine for now.
const jobs = new Map<string, JobSnapshot>();

function snapshot(job: JobSnapshot): JobSnapshot {
  return {
    ...job,
    lines: job.lines.slice(),
    instance: job.instance ? { ...job.instance } : undefined,
  };
}

function appendLine(job: JobSnapshot, line: string) {
  // Drop trailing CR/LF, never write empty lines, cap memory usage.
  const trimmed = line.replace(/\r?\n$/, '');
  if (!trimmed) return;
  job.lines.push(trimmed);
  if (job.lines.length > MAX_LOG_LINES) {
    job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
  }
}

function shellQuote(value: string): string {
  // POSIX-safe single-quoting for argv values. Escape embedded single quotes
  // by closing the quote, inserting an escaped quote, reopening.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function generateSecurePassword(): string {
  // 24 bytes of base64url -> ~32 chars, URL/CLI safe and free of shell
  // metacharacters that would need quoting beyond what shellQuote handles.
  return randomBytes(24)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildCommand(
  cfg: OrchestratorConfig,
  req: ProvisionRequest,
): string {
  const args: string[] = [
    cfg.scriptPath,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--hostname', req.hostname,
    '--domain', req.domain,
    '--email', req.email,
    '--dhis2-version', req.version,
    '--db-name', req.database.name,
    '--db-user', req.database.user,
    '--instance-name', req.name,
    '--cpu', String(req.resources.cpu),
    '--memory', String(req.resources.memory),
    '--storage', String(req.resources.storage),
  ];
  if (req.newDbAccount?.user) {
    args.push('--new-db-user', req.newDbAccount.user);
  }
  // Shared/external PostgreSQL target. When omitted the script defaults
  // to installing PostgreSQL inside the new LXC.
  if (req.database.host && req.database.host.trim() !== '') {
    args.push('--db-host', req.database.host.trim());
    if (req.database.port && Number.isInteger(req.database.port)) {
      args.push('--db-port', String(req.database.port));
    }
  }
  if (req.database.existing) {
    args.push('--existing-db');
  }
  if (cfg.skipCertbot || req.skipCertbot) {
    args.push('--skip-certbot');
  }
  if (req.deleteIfExists) {
    args.push('--delete-if-exists');
  }
  if (req.tomcatVersion && req.tomcatVersion.trim() !== '') {
    args.push('--tomcat-version', req.tomcatVersion.trim());
  }
  // The provision script also needs an SSH key (used by Ansible to talk to
  // the freshly-created LXC). Reuse the orchestrator key when configured so
  // operators don't have to wire the same path in two places.
  const orchestratorSshKey = normalizeSshPrivateKeyPath(cfg.privateKeyFile);
  if (orchestratorSshKey) {
    args.push('--ssh-key', orchestratorSshKey);
  }
  // Reverse-proxy server overrides. Each field is forwarded only when the
  // request actually supplied it; the script applies its own defaults
  // (typically the PVE host, root, port 22, /etc/nginx/upstream, etc.)
  // when a flag is absent.
  const proxy = req.proxy ?? {};
  if (proxy.host && proxy.host.trim() !== '') {
    args.push('--proxy-host', proxy.host.trim());
  }
  if (proxy.sshPort && Number.isInteger(proxy.sshPort)) {
    args.push('--proxy-port', String(proxy.sshPort));
  }
  if (proxy.sshUser && proxy.sshUser.trim() !== '') {
    args.push('--proxy-user', proxy.sshUser.trim());
  }
  const proxySshKey = normalizeSshPrivateKeyPath(proxy.sshKeyPath);
  if (proxySshKey) {
    args.push('--proxy-ssh-key', proxySshKey);
  }
  if (proxy.nginxConfigPath && proxy.nginxConfigPath.trim() !== '') {
    args.push('--proxy-nginx-dir', proxy.nginxConfigPath.trim());
  }
  if (proxy.nginxReloadCommand && proxy.nginxReloadCommand.trim() !== '') {
    args.push('--proxy-nginx-reload', proxy.nginxReloadCommand.trim());
  }
  // Secrets + Proxmox API credentials go via env vars, NEVER on argv.
  // Per-request `req.proxmox.*` values (typically forwarded from the
  // ProxmoxClusterPanel saved settings) override the orchestrator
  // defaults from app-config / env vars on a per-job basis.
  const reqPm = req.proxmox ?? {};
  const effectiveApiUrl =
    (reqPm.apiUrl && reqPm.apiUrl.trim()) || cfg.apiUrl;
  const { apiUser: effectiveApiUser, apiTokenId: effectiveApiTokenId } =
    normalizeProxmoxCreds(
      (reqPm.apiUser && reqPm.apiUser.trim()) || cfg.apiUser,
      (reqPm.apiTokenId && reqPm.apiTokenId.trim()) || cfg.apiTokenId,
    );
  const effectiveApiTokenSecret =
    (reqPm.apiTokenSecret && reqPm.apiTokenSecret.trim()) ||
    cfg.apiTokenSecret;
  // TLS validation policy: app-config is the SECURITY CEILING. A
  // per-request override (e.g. from a stored ProxmoxClusterPanel
  // setting in the browser) can only LOWER the policy, never raise it.
  // This prevents a stale `verifyTls: true` in localStorage from
  // overriding an operator who has intentionally set
  // `dhis2.orchestrator.validateApiCerts: false` in app-config because
  // their PVE node uses the stock self-signed cert.
  const cfgValidate = Boolean(cfg.validateApiCerts);
  const reqValidate =
    typeof reqPm.validateApiCerts === 'boolean'
      ? reqPm.validateApiCerts
      : cfgValidate;
  const effectiveValidateCerts = cfgValidate && reqValidate;

  const env: Record<string, string> = {
    DHIS2_DB_PASS: req.database.password,
    DHIS2_ADMIN_PASS: req.adminPassword ?? '',
    ROOT_PASSWORD: req.rootPassword ?? req.adminPassword ?? '',
    PROXMOX_API_URL: effectiveApiUrl,
    PROXMOX_USER: effectiveApiUser,
    PROXMOX_TOKEN_ID: effectiveApiTokenId,
    PROXMOX_TOKEN_SECRET: effectiveApiTokenSecret,
    PROXMOX_VALIDATE_CERTS: effectiveValidateCerts ? 'true' : 'false',
  };
  if (req.newDbAccount?.password) {
    env.NEW_DB_PASS = req.newDbAccount.password;
  }
  // Admin credentials for the shared PostgreSQL host. Only sent when the
  // operator has configured one in Database Configurations.
  if (req.database.host && req.database.host.trim() !== '') {
    env.DHIS2_DB_ADMIN_USER = req.databaseAdmin?.user || 'postgres';
    env.DHIS2_DB_ADMIN_PASS = req.databaseAdmin?.password || '';
  }
  // Pass through DHIS2_DEBUG from the backend process env. When the
  // operator starts Backstage with DHIS2_DEBUG=1, provision-instance.sh
  // runs ansible-playbook with -vvv and -e dhis2_debug=true, which
  // disables the no_log gates in roles/pve_lxc/tasks/main.yml so that
  // Proxmox API failures (auth, vmid clash, missing template, etc.) are
  // surfaced verbatim instead of "censored ... no_log: true".
  const debugFlag = process.env.DHIS2_DEBUG;
  if (debugFlag && debugFlag !== '0' && debugFlag.toLowerCase() !== 'false') {
    env.DHIS2_DEBUG = '1';
  }
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const quotedArgs = args.map(shellQuote).join(' ');
  // bash -lc so login env (PATH, ansible) is loaded.
  return `${envPrefix} bash -lc ${shellQuote(quotedArgs)}`;
}

function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function resolvePveHost(
  cfg: OrchestratorConfig,
  req: ProvisionRequest,
): string {
  // Explicit override wins (including an explicit '' / 'localhost' to opt
  // out of SSH wrapping when Backstage is colocated with PVE).
  if (cfg.pveHost !== undefined) return cfg.pveHost;
  if (cfg.host && !isLocalHost(cfg.host)) return cfg.host;
  // Last resort: drive the per-request PVE node directly.
  return req.node;
}

function streamLines(
  job: JobSnapshot,
  stream: NodeJS.ReadableStream,
  prefix: string,
) {
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) appendLine(job, prefix ? `${prefix}${line}` : line);
  });
  stream.on('end', () => {
    if (buf) appendLine(job, prefix ? `${prefix}${buf}` : buf);
  });
}

async function runLocal(job: JobSnapshot, command: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    // The `command` already includes the env-var prefix and `bash -lc '...'`,
    // so just hand it to a top-level shell.
    const child = spawn('bash', ['-lc', command], { stdio: 'pipe' });
    streamLines(job, child.stdout, '');
    streamLines(job, child.stderr, '[stderr] ');
    child.on('error', reject);
    child.on('close', code => resolve(typeof code === 'number' ? code : -1));
  });
}

async function appendInstanceToState(
  store: InstanceStore,
  inst: PersistedInstance,
  logger: LoggerService,
): Promise<void> {
  try {
    await store.upsert(inst);
  } catch (err) {
    logger.warn(
      `DHIS2: failed to persist instance ${inst.id} to plugin database: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Remove a persisted instance from the orchestrator state file. Best-effort:
 * if the state file is missing or unreadable, the function is a no-op.
 */
async function removeInstanceFromState(
  store: InstanceStore,
  instanceId: string,
  logger: LoggerService,
): Promise<void> {
  try {
    await store.deleteById(instanceId);
  } catch (err) {
    logger.warn(
      `DHIS2: failed to remove instance ${instanceId} from plugin database: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Apply a partial update to the persisted instance record. Best-effort:
 * a missing or unreadable state file is treated as a no-op (the live
 * Proxmox reconciliation will catch the drift on the next poll).
 */
async function updateInstanceInState(
  store: InstanceStore,
  instanceId: string,
  patch: Partial<PersistedInstance>,
  logger: LoggerService,
): Promise<PersistedInstance | null> {
  try {
    return await store.updateById(instanceId, patch);
  } catch (err) {
    logger.warn(
      `DHIS2: failed to update instance ${instanceId} in plugin database: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function buildEditCommand(
  cfg: OrchestratorConfig,
  req: EditRequest,
  scriptPath: string,
): string {
  const args: string[] = [
    scriptPath,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--domain', req.domain,
    '--cpu', String(req.resources.cpu),
    '--memory', String(req.resources.memory),
    '--storage', String(req.resources.storage),
    '--db-name', req.database.name,
    '--db-user', req.database.user,
  ];
  if (req.database.host && req.database.host.trim() !== '') {
    args.push('--db-host', req.database.host.trim());
    if (req.database.port && Number.isInteger(req.database.port)) {
      args.push('--db-port', String(req.database.port));
    }
  }
  if (req.restartTomcat === false) {
    args.push('--no-restart-tomcat');
  }
  // SSH details for the PVE host that runs `pct push` / `pct exec`. The
  // edit playbook does not touch the central proxy host (no nginx config
  // changes), so only the Proxmox-side SSH fields are forwarded.
  const proxy = req.proxy ?? {};
  if (proxy.host && proxy.host.trim() !== '') {
    args.push('--pve-host', proxy.host.trim());
  }
  if (proxy.sshPort && Number.isInteger(proxy.sshPort)) {
    args.push('--pve-port', String(proxy.sshPort));
  }
  if (proxy.sshUser && proxy.sshUser.trim() !== '') {
    args.push('--pve-user', proxy.sshUser.trim());
  }
  const pveSshKey = normalizeSshPrivateKeyPath(proxy.sshKeyPath);
  if (pveSshKey) {
    args.push('--pve-ssh-key', pveSshKey);
  } else {
    const fallbackPveSshKey = normalizeSshPrivateKeyPath(cfg.privateKeyFile);
    if (fallbackPveSshKey) {
      args.push('--pve-ssh-key', fallbackPveSshKey);
    }
  }

  const reqPm = req.proxmox ?? {};
  const effectiveApiUrl =
    (reqPm.apiUrl && reqPm.apiUrl.trim()) || cfg.apiUrl;
  const { apiUser: effectiveApiUser, apiTokenId: effectiveApiTokenId } =
    normalizeProxmoxCreds(
      (reqPm.apiUser && reqPm.apiUser.trim()) || cfg.apiUser,
      (reqPm.apiTokenId && reqPm.apiTokenId.trim()) || cfg.apiTokenId,
    );
  const effectiveApiTokenSecret =
    (reqPm.apiTokenSecret && reqPm.apiTokenSecret.trim()) ||
    cfg.apiTokenSecret;
  const cfgValidate = Boolean(cfg.validateApiCerts);
  const reqValidate =
    typeof reqPm.validateApiCerts === 'boolean'
      ? reqPm.validateApiCerts
      : cfgValidate;
  const effectiveValidateCerts = cfgValidate && reqValidate;

  const env: Record<string, string> = {
    PROXMOX_API_URL: effectiveApiUrl,
    PROXMOX_USER: effectiveApiUser,
    PROXMOX_TOKEN_ID: effectiveApiTokenId,
    PROXMOX_TOKEN_SECRET: effectiveApiTokenSecret,
    PROXMOX_VALIDATE_CERTS: effectiveValidateCerts ? 'true' : 'false',
    DHIS2_DB_PASS: req.database.password,
  };
  const debugFlag = process.env.DHIS2_DEBUG;
  if (debugFlag && debugFlag !== '0' && debugFlag.toLowerCase() !== 'false') {
    env.DHIS2_DEBUG = '1';
  }
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const quotedArgs = args.map(shellQuote).join(' ');
  return `${envPrefix} bash -lc ${shellQuote(quotedArgs)}`;
}

function buildDecommissionCommand(
  cfg: OrchestratorConfig,
  req: DecommissionRequest,
  scriptPath: string,
): string {
  const args: string[] = [
    scriptPath,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--domain', req.domain,
  ];
  if (req.skipProxyCleanup) {
    args.push('--skip-proxy-cleanup');
  }
  const proxy = req.proxy ?? {};
  if (proxy.host && proxy.host.trim() !== '') {
    args.push('--proxy-host', proxy.host.trim());
  }
  if (proxy.sshPort && Number.isInteger(proxy.sshPort)) {
    args.push('--proxy-port', String(proxy.sshPort));
  }
  if (proxy.sshUser && proxy.sshUser.trim() !== '') {
    args.push('--proxy-user', proxy.sshUser.trim());
  }
  const proxySshKey = normalizeSshPrivateKeyPath(proxy.sshKeyPath);
  if (proxySshKey) {
    args.push('--proxy-ssh-key', proxySshKey);
  }
  if (proxy.nginxConfigPath && proxy.nginxConfigPath.trim() !== '') {
    args.push('--proxy-nginx-dir', proxy.nginxConfigPath.trim());
  }
  if (proxy.nginxReloadCommand && proxy.nginxReloadCommand.trim() !== '') {
    args.push('--proxy-nginx-reload', proxy.nginxReloadCommand.trim());
  }
  const orchestratorSshKey = normalizeSshPrivateKeyPath(cfg.privateKeyFile);
  if (orchestratorSshKey) {
    args.push('--ssh-key', orchestratorSshKey);
  }
  const db = req.database ?? {};
  if (req.dropDatabase) {
    args.push('--drop-database');
    if (db.host && db.host.trim() !== '') {
      args.push('--db-host', db.host.trim());
    }
    if (db.port && Number.isInteger(db.port)) {
      args.push('--db-port', String(db.port));
    }
    if (db.name && db.name.trim() !== '') {
      args.push('--db-name', db.name.trim());
    }
    if (db.user && db.user.trim() !== '') {
      args.push('--db-user', db.user.trim());
    }
  }

  const reqPm = req.proxmox ?? {};
  const effectiveApiUrl =
    (reqPm.apiUrl && reqPm.apiUrl.trim()) || cfg.apiUrl;
  const { apiUser: effectiveApiUser, apiTokenId: effectiveApiTokenId } =
    normalizeProxmoxCreds(
      (reqPm.apiUser && reqPm.apiUser.trim()) || cfg.apiUser,
      (reqPm.apiTokenId && reqPm.apiTokenId.trim()) || cfg.apiTokenId,
    );
  const effectiveApiTokenSecret =
    (reqPm.apiTokenSecret && reqPm.apiTokenSecret.trim()) ||
    cfg.apiTokenSecret;
  const cfgValidate = Boolean(cfg.validateApiCerts);
  const reqValidate =
    typeof reqPm.validateApiCerts === 'boolean'
      ? reqPm.validateApiCerts
      : cfgValidate;
  const effectiveValidateCerts = cfgValidate && reqValidate;

  const env: Record<string, string> = {
    PROXMOX_API_URL: effectiveApiUrl,
    PROXMOX_USER: effectiveApiUser,
    PROXMOX_TOKEN_ID: effectiveApiTokenId,
    PROXMOX_TOKEN_SECRET: effectiveApiTokenSecret,
    PROXMOX_VALIDATE_CERTS: effectiveValidateCerts ? 'true' : 'false',
  };
  if (req.dropDatabase) {
    env.DHIS2_DB_ADMIN_USER = req.databaseAdmin?.user || 'postgres';
    env.DHIS2_DB_ADMIN_PASS = req.databaseAdmin?.password || '';
  }
  const debugFlag = process.env.DHIS2_DEBUG;
  if (debugFlag && debugFlag !== '0' && debugFlag.toLowerCase() !== 'false') {
    env.DHIS2_DEBUG = '1';
  }
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const quotedArgs = args.map(shellQuote).join(' ');
  return `${envPrefix} bash -lc ${shellQuote(quotedArgs)}`;
}

export class ProvisionService {
  constructor(
    private readonly logger: LoggerService,
    private readonly cfg: OrchestratorConfig | null,
    private readonly instanceStore: InstanceStore,
  ) {}

  isConfigured(): boolean {
    return this.cfg !== null;
  }

  /**
   * One-time migration path from legacy JSON state file persistence to
   * plugin-database persistence. Safe to run multiple times.
   */
  async importLegacyStateFile(): Promise<void> {
    if (!this.cfg?.stateFile) return;
    try {
      const raw = await fs.readFile(this.cfg.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const existing = await this.instanceStore.list();
      const existingIds = new Set(existing.map(i => i.id));
      let imported = 0;
      for (const item of parsed as PersistedInstance[]) {
        if (!item?.id || existingIds.has(item.id)) continue;
        await this.instanceStore.upsert(item);
        imported += 1;
      }
      if (imported > 0) {
        this.logger.info(
          `DHIS2: imported ${imported} instance(s) from legacy state file ${this.cfg.stateFile}`,
        );
      }
    } catch {
      // Ignore missing/invalid legacy file. DB remains source of truth.
    }
  }

  async listInstances(): Promise<PersistedInstance[]> {
    try {
      return await this.instanceStore.list();
    } catch {
      return [];
    }
  }

  getJob(id: string): JobSnapshot | null {
    const j = jobs.get(id);
    return j ? snapshot(j) : null;
  }

  /**
   * Start a provisioning job. Returns the job id immediately; the SSH
   * session runs asynchronously and streams stdout/stderr into the job's
   * log buffer.
   */
  startJob(req: ProvisionRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Provisioning is not configured. Set dhis2.orchestrator in app-config.yaml.',
      );
    }
    const cfg = this.cfg;
    const id = randomUUID();
    // Auto-generate a strong admin password when the caller didn't supply
    // one, and surface it via the job log so the operator can record it.
    let adminPasswordWasGenerated = false;
    if (!req.adminPassword) {
      req.adminPassword = generateSecurePassword();
      adminPasswordWasGenerated = true;
    }
    // Same treatment for the per-instance PostgreSQL role password. The
    // Create Instance dialog hides the Database Password field by default
    // (PostgreSQL is installed inside the LXC and there's no reason to
    // burden the operator with picking a password for a brand-new local
    // role). The provisioning log surfaces the generated value once.
    let dbPasswordWasGenerated = false;
    if (!req.database.password || req.database.password.trim() === '') {
      req.database.password = generateSecurePassword();
      dbPasswordWasGenerated = true;
    }
    const job: JobSnapshot = {
      id,
      status: 'queued',
      startedAt: new Date().toISOString(),
      lines: [],
      request: {
        name: req.name,
        domain: req.domain,
        version: req.version,
        node: req.node,
        vmid: req.vmid,
      },
    };
    jobs.set(id, job);

    if (adminPasswordWasGenerated) {
      appendLine(
        job,
        `[backend] Generated DHIS2 admin password: ${req.adminPassword} -- copy this now, it will not be shown again`,
      );
    }
    if (dbPasswordWasGenerated) {
      appendLine(
        job,
        `[backend] Generated PostgreSQL password for role '${req.database.user}': ${req.database.password} -- copy this now, it will not be shown again`,
      );
    }

    // Fire-and-forget. All errors are captured into the job snapshot.
    this.runJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(`DHIS2: provision job ${id} crashed: ${job.error}`);
    });

    return snapshot(job);
  }

  private async runJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: ProvisionRequest,
  ): Promise<void> {
    job.status = 'running';
    appendLine(
      job,
      `[backend] Running provision-instance.sh locally on the Backstage host. Proxmox API: ${cfg.apiUser}@${cfg.apiUrl} (LXC lifecycle via REST; nginx via SSH to ${resolvePveHost(cfg, req) || 'localhost'}).`,
    );

    const command = buildCommand(cfg, req);
    // Surface the effective TLS validation policy so operators can see
    // when a stale browser setting was clamped by the app-config ceiling.
    const cfgValidate = Boolean(cfg.validateApiCerts);
    const reqValidate = req.proxmox?.validateApiCerts;
    if (reqValidate === true && cfgValidate === false) {
      appendLine(
        job,
        `[backend] Per-job validateApiCerts=true ignored because dhis2.orchestrator.validateApiCerts=false in app-config (PVE self-signed cert). Set both to true to enforce TLS validation.`,
      );
    }
    // Log the redacted form for traceability.
    appendLine(
      job,
      `[backend] Executing: ${cfg.scriptPath} --vmid ${req.vmid} --node ${req.node} --hostname ${req.hostname} --domain ${req.domain} --dhis2-version ${req.version} --db-name ${req.database.name} --db-user ${req.database.user} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);

    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    if (exitCode === 0) {
      job.status = 'success';
      const inst: PersistedInstance = {
        id: `dhis2-${req.vmid}`,
        name: req.name,
        vmid: String(req.vmid),
        node: req.node,
        status: 'running',
        version: req.version,
        url: `https://${req.domain}`,
        domain: req.domain,
        database: {
          name: req.database.name,
          user: req.database.user,
          host: req.database.host,
          port: req.database.port,
          password: req.database.password,
          existing: req.database.existing,
        },
        resources: req.resources,
        tomcatVersion: req.tomcatVersion,
        proxyOverride: req.proxyOverride,
        restore:
          req.restore && typeof req.restore === 'object'
            ? (req.restore as Record<string, unknown>)
            : undefined,
        proxySettings: req.proxySettings
          ? {
              mode: req.proxySettings.mode,
              baseDomain: req.proxySettings.baseDomain,
              pathPrefix: req.proxySettings.pathPrefix,
              host: req.proxySettings.host,
              sshPort: req.proxySettings.sshPort,
              sshUser: req.proxySettings.sshUser,
              sshKeyPath: req.proxySettings.sshKeyPath,
              nginxConfigPath: req.proxySettings.nginxConfigPath,
              nginxReloadCommand: req.proxySettings.nginxReloadCommand,
              sslProvider: req.proxySettings.sslProvider,
              letsencryptEmail: req.proxySettings.letsencryptEmail,
              sslCertPath: req.proxySettings.sslCertPath,
              sslKeyPath: req.proxySettings.sslKeyPath,
              forceHttps: req.proxySettings.forceHttps,
              enableHsts: req.proxySettings.enableHsts,
              upstreamPort: req.proxySettings.upstreamPort,
            }
          : undefined,
        // Intentionally skip postgresAdminPassword when persisting this
        // snapshot; keep only non-secret defaults useful for later edits.
        dhis2Settings: req.dhis2Settings
          ? {
              defaultVersion: req.dhis2Settings.defaultVersion,
              javaHeap: req.dhis2Settings.javaHeap,
              tomcatPort: req.dhis2Settings.tomcatPort,
              defaultCpu: req.dhis2Settings.defaultCpu,
              defaultMemoryMb: req.dhis2Settings.defaultMemoryMb,
              defaultStorageGb: req.dhis2Settings.defaultStorageGb,
              postgresHost: req.dhis2Settings.postgresHost,
              postgresPort: req.dhis2Settings.postgresPort,
              postgresAdminUser: req.dhis2Settings.postgresAdminUser,
              backupEnabled: req.dhis2Settings.backupEnabled,
              backupSchedule: req.dhis2Settings.backupSchedule,
              backupRetentionDays: req.dhis2Settings.backupRetentionDays,
              backupBucket: req.dhis2Settings.backupBucket,
            }
          : undefined,
        created: job.startedAt,
        updated: job.finishedAt,
      };
      job.instance = inst;
      appendLine(job, `[backend] provision-instance.sh exited 0`);
      await appendInstanceToState(this.instanceStore, inst, this.logger);
      // Best-effort: tag the new LXC so reconciliation can verify it
      // belongs to this plugin. Non-fatal — a tagging failure only loses
      // the secondary marker, the registry entry is already persisted.
      await this.tagInstance(job, cfg, req).catch(err => {
        appendLine(
          job,
          `[backend] WARN: failed to tag LXC ${req.vmid} on ${req.node}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } else {
      job.status = 'failed';
      job.error = `provision-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }
  }

  /**
   * Start a decommission job. Returns the job id immediately; the script
   * runs asynchronously and streams stdout/stderr into the job's log
   * buffer just like `startJob`. On success the persisted instance is
   * removed from the registry.
   */
  startDecommissionJob(req: DecommissionRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Decommission is not configured. Set dhis2.orchestrator in app-config.yaml.',
      );
    }
    const cfg = this.cfg;
    const id = randomUUID();
    const job: JobSnapshot = {
      id,
      status: 'queued',
      startedAt: new Date().toISOString(),
      lines: [],
      request: {
        name: req.name,
        domain: req.domain,
        version: '',
        node: req.node,
        vmid: req.vmid,
      },
    };
    jobs.set(id, job);

    this.runDecommissionJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(
        `DHIS2: decommission job ${id} crashed: ${job.error}`,
      );
    });

    return snapshot(job);
  }

  private async runDecommissionJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: DecommissionRequest,
  ): Promise<void> {
    job.status = 'running';
    const decommissionScript = path.join(
      path.dirname(cfg.scriptPath),
      'delete-instance.sh',
    );
    appendLine(
      job,
      `[backend] Running delete-instance.sh locally on the Backstage host for instance "${req.name}" (vmid=${req.vmid}, node=${req.node}, domain=${req.domain}).`,
    );

    const command = buildDecommissionCommand(cfg, req, decommissionScript);
    appendLine(
      job,
      `[backend] Executing: ${decommissionScript} --vmid ${req.vmid} --node ${req.node} --domain ${req.domain} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();

    if (exitCode === 0) {
      job.status = 'success';
      appendLine(job, `[backend] delete-instance.sh exited 0`);
      // Remove the instance from the persisted state file. Best-effort —
      // a missing or unreadable state file is not fatal.
      try {
        await removeInstanceFromState(
          this.instanceStore,
          req.instanceId,
          this.logger,
        );
        appendLine(
          job,
          `[backend] Removed instance ${req.instanceId} from registry`,
        );
      } catch (err) {
        appendLine(
          job,
          `[backend] WARN: failed to update registry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      job.status = 'failed';
      job.error = `delete-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }
  }

  /**
   * Start an edit job. Returns the job id immediately; the wrapper
   * script runs asynchronously and streams stdout/stderr into the job's
   * log buffer (same pattern as `startJob` / `startDecommissionJob`).
   * On success the persisted instance record is updated to reflect the
   * applied changes.
   */
  startEditJob(req: EditRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Edit is not configured. Set dhis2.orchestrator in app-config.yaml.',
      );
    }
    const cfg = this.cfg;
    const id = randomUUID();
    const job: JobSnapshot = {
      id,
      status: 'queued',
      startedAt: new Date().toISOString(),
      lines: [],
      request: {
        name: req.name,
        domain: req.domain,
        version: req.version,
        node: req.node,
        vmid: req.vmid,
      },
    };
    jobs.set(id, job);

    this.runEditJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(`DHIS2: edit job ${id} crashed: ${job.error}`);
    });

    return snapshot(job);
  }

  private async runEditJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: EditRequest,
  ): Promise<void> {
    job.status = 'running';
    const editScript = path.join(
      path.dirname(cfg.scriptPath),
      'edit-instance.sh',
    );
    appendLine(
      job,
      `[backend] Running edit-instance.sh locally on the Backstage host for instance "${req.name}" (vmid=${req.vmid}, node=${req.node}, domain=${req.domain}).`,
    );
    appendLine(
      job,
      `[backend] Target resources: cpu=${req.resources.cpu}, memory=${req.resources.memory}MB, storage=${req.resources.storage}GB. DB: ${req.database.user}@${req.database.host || 'localhost'}:${req.database.port ?? 5432}/${req.database.name}.`,
    );

    const command = buildEditCommand(cfg, req, editScript);
    appendLine(
      job,
      `[backend] Executing: ${editScript} --vmid ${req.vmid} --node ${req.node} --domain ${req.domain} --cpu ${req.resources.cpu} --memory ${req.resources.memory} --storage ${req.resources.storage} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();

    if (exitCode === 0) {
      job.status = 'success';
      appendLine(job, `[backend] edit-instance.sh exited 0`);
      try {
        const updated = await updateInstanceInState(
          this.instanceStore,
          req.instanceId,
          {
            name: req.name,
            version: req.version,
            resources: req.resources,
            database: {
              name: req.database.name,
              user: req.database.user,
              host: req.database.host,
              port: req.database.port,
              password: req.database.password,
            },
          },
          this.logger,
        );
        if (updated) {
          job.instance = updated;
          appendLine(
            job,
            `[backend] Updated instance ${req.instanceId} in registry.`,
          );
        } else {
          appendLine(
            job,
            `[backend] WARN: instance ${req.instanceId} not found in registry; live changes applied but registry untouched.`,
          );
        }
      } catch (err) {
        appendLine(
          job,
          `[backend] WARN: failed to update registry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      job.status = 'failed';
      job.error = `edit-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }
  }

  /**
   * Expose the effective Proxmox credentials so the router / registry can
   * call the Proxmox API for reconciliation. Returns null when the plugin
   * has not been configured with API credentials.
   */
  proxmoxCredentials(): ProxmoxApiCredentials | null {
    if (
      !this.cfg ||
      !this.cfg.apiUrl ||
      !this.cfg.apiUser ||
      !this.cfg.apiTokenId ||
      !this.cfg.apiTokenSecret
    ) {
      return null;
    }
    return {
      apiUrl: this.cfg.apiUrl,
      apiUser: this.cfg.apiUser,
      apiTokenId: this.cfg.apiTokenId,
      apiTokenSecret: this.cfg.apiTokenSecret,
      validateCerts: Boolean(this.cfg.validateApiCerts),
    };
  }

  private async tagInstance(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: ProvisionRequest,
  ): Promise<void> {
    // Resolve effective per-job Proxmox creds (request can override config).
    const reqPm = req.proxmox ?? {};
    const apiUrl = (reqPm.apiUrl && reqPm.apiUrl.trim()) || cfg.apiUrl;
    const apiUser =
      (reqPm.apiUser && reqPm.apiUser.trim()) || cfg.apiUser;
    const apiTokenId =
      (reqPm.apiTokenId && reqPm.apiTokenId.trim()) || cfg.apiTokenId;
    const apiTokenSecret =
      (reqPm.apiTokenSecret && reqPm.apiTokenSecret.trim()) ||
      cfg.apiTokenSecret;
    if (!apiUrl || !apiUser || !apiTokenId || !apiTokenSecret) {
      appendLine(
        job,
        `[backend] Skipping Proxmox tag step: API credentials not configured.`,
      );
      return;
    }
    const validateCerts =
      typeof reqPm.validateApiCerts === 'boolean'
        ? reqPm.validateApiCerts && Boolean(cfg.validateApiCerts)
        : Boolean(cfg.validateApiCerts);
    const tags = DHIS2_TAGS.split(';');
    const applied = await ensureLxcTags(
      { apiUrl, apiUser, apiTokenId, apiTokenSecret, validateCerts },
      req.node,
      req.vmid,
      tags,
      this.logger,
    );
    appendLine(
      job,
      `[backend] Tagged LXC ${req.vmid} on ${req.node}: tags="${applied}"`,
    );
  }

  // ---------------------------------------------------------------------
  // Proxy file inspection / editing
  // ---------------------------------------------------------------------
  // The Edit Settings dialog lets operators read and rewrite the two
  // nginx config files that drive a single DHIS2 instance: the per-
  // instance upstream snippet (in `proxy.nginxConfigPath`, default
  // /etc/nginx/upstream) and the vhost / "dhis.conf" file. Both live on
  // the central proxy host and are accessed via SSH — the same channel
  // configure-host-proxy.sh and delete-instance.sh use.

  async readProxyFiles(
    instanceId: string,
    overrides: ProxyAccessOverrides,
  ): Promise<ProxyFilesResponse> {
    if (!this.cfg) throw new Error('Orchestrator not configured.');
    const inst = await this.findInstance(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found.`);
    const access = resolveProxyAccess(this.cfg, overrides);
    const paths = derivProxyFilePaths(inst, overrides);
    const upstreamContent = await sshReadFile(access, paths.upstreamFile);
    const siteContent = await sshReadFile(access, paths.siteFile);
    return {
      upstream: { path: paths.upstreamFile, content: upstreamContent.content, exists: upstreamContent.exists },
      site: { path: paths.siteFile, content: siteContent.content, exists: siteContent.exists },
    };
  }

  async writeProxyFiles(
    instanceId: string,
    overrides: ProxyAccessOverrides,
    body: { upstream?: string; site?: string; reload?: boolean },
  ): Promise<ProxyWriteResult> {
    if (!this.cfg) throw new Error('Orchestrator not configured.');
    const inst = await this.findInstance(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found.`);
    const access = resolveProxyAccess(this.cfg, overrides);
    const paths = derivProxyFilePaths(inst, overrides);
    const written: string[] = [];
    if (typeof body.upstream === 'string') {
      await sshWriteFile(access, paths.upstreamFile, body.upstream);
      written.push(paths.upstreamFile);
    }
    if (typeof body.site === 'string') {
      await sshWriteFile(access, paths.siteFile, body.site);
      written.push(paths.siteFile);
    }
    let reload: { ok: boolean; output: string } | undefined;
    if (body.reload && written.length > 0) {
      const reloadCmd =
        (overrides.nginxReloadCommand && overrides.nginxReloadCommand.trim()) ||
        'sudo nginx -t && sudo systemctl reload nginx';
      const r = await sshExec(access, reloadCmd);
      reload = { ok: r.code === 0, output: r.stdout + r.stderr };
      if (!reload.ok) {
        throw new Error(
          `nginx reload failed (exit ${r.code}): ${reload.output.trim()}`,
        );
      }
    }
    return { written, reload };
  }

  private async findInstance(id: string): Promise<PersistedInstance | null> {
    const list = await this.listInstances();
    return list.find(i => i.id === id) ?? null;
  }
}

// -------------------------------------------------------------------------
// Proxy file helpers (SSH-based read/write of the per-instance nginx confs)
// -------------------------------------------------------------------------

export interface ProxyAccessOverrides {
  host?: string;
  sshPort?: number;
  sshUser?: string;
  sshKeyPath?: string;
  nginxConfigPath?: string;
  nginxReloadCommand?: string;
  /**
   * Optional explicit path for the site/vhost file. When omitted, derived
   * from the instance's routing mode (subdomain vs path-based) using the
   * same defaults configure-host-proxy.sh applies.
   */
  sitesAvailable?: string;
}

interface ProxyAccess {
  host: string;
  port: number;
  user: string;
  keyPath?: string;
}

export interface ProxyFilesResponse {
  upstream: { path: string; content: string; exists: boolean };
  site: { path: string; content: string; exists: boolean };
}

export interface ProxyWriteResult {
  written: string[];
  reload?: { ok: boolean; output: string };
}

function resolveProxyAccess(
  cfg: OrchestratorConfig,
  o: ProxyAccessOverrides,
): ProxyAccess {
  const host = (o.host && o.host.trim()) || cfg.pveHost || cfg.host;
  if (!host) throw new Error('Proxy host is not configured.');
  const port = o.sshPort && Number.isInteger(o.sshPort) && o.sshPort > 0
    ? o.sshPort
    : cfg.port || 22;
  const user = (o.sshUser && o.sshUser.trim()) || cfg.user || 'root';
  const keyPath =
    normalizeSshPrivateKeyPath(o.sshKeyPath) ||
    normalizeSshPrivateKeyPath(cfg.privateKeyFile);
  return { host, port, user, keyPath: keyPath || undefined };
}

function derivProxyFilePaths(
  inst: PersistedInstance,
  o: ProxyAccessOverrides,
): { upstreamFile: string; siteFile: string } {
  const upstreamDir =
    (o.nginxConfigPath && o.nginxConfigPath.trim()) || '/etc/nginx/upstream';
  const domain = inst.domain;
  if (domain.includes('/')) {
    // Path-based routing: <fqdn>/<instance>
    const baseDomain = domain.split('/')[0];
    let instanceName = domain.slice(domain.indexOf('/') + 1);
    instanceName = instanceName.replace(/^\/+|\/+$/g, '');
    if (!baseDomain || !instanceName) {
      throw new Error(`Malformed domain for path mode: "${domain}"`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(instanceName)) {
      throw new Error(
        `Instance segment "${instanceName}" contains characters unsafe for a filename.`,
      );
    }
    const sitesAvailable =
      (o.sitesAvailable && o.sitesAvailable.trim()) ||
      '/etc/nginx/sites-available';
    return {
      upstreamFile: `${upstreamDir}/${instanceName}.conf`,
      siteFile: `${sitesAvailable}/${baseDomain}.conf`,
    };
  }
  // Subdomain mode — one .conf per FQDN, files live in conf.d by default.
  const sitesAvailable =
    (o.sitesAvailable && o.sitesAvailable.trim()) || '/etc/nginx/conf.d';
  return {
    upstreamFile: `${upstreamDir}/dhis2-${inst.vmid}.conf`,
    siteFile: `${sitesAvailable}/dhis2-${domain}.conf`,
  };
}

function sshBaseArgs(a: ProxyAccess): string[] {
  const args: string[] = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-p', String(a.port),
  ];
  if (a.keyPath) {
    args.push('-i', a.keyPath);
  }
  args.push(`${a.user}@${a.host}`);
  return args;
}

function execCapture(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d.toString('utf8')));
    child.stderr.on('data', d => (stderr += d.toString('utf8')));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function sshReadFile(
  a: ProxyAccess,
  remotePath: string,
): Promise<{ content: string; exists: boolean }> {
  // Print a sentinel when the file doesn't exist so we can distinguish
  // "missing" from "empty file" without a second round-trip.
  const remoteCmd =
    `if [ -f ${shellQuote(remotePath)} ]; then cat ${shellQuote(remotePath)}; ` +
    `else echo __DHIS2_PROXY_FILE_MISSING__; fi`;
  const r = await execCapture('ssh', [...sshBaseArgs(a), remoteCmd]);
  if (r.code !== 0) {
    throw new Error(
      `ssh ${a.user}@${a.host} read ${remotePath} failed (exit ${r.code}): ${r.stderr.trim()}`,
    );
  }
  if (r.stdout.trim() === '__DHIS2_PROXY_FILE_MISSING__') {
    return { content: '', exists: false };
  }
  return { content: r.stdout, exists: true };
}

async function sshWriteFile(
  a: ProxyAccess,
  remotePath: string,
  content: string,
): Promise<void> {
  // tee with sudo so we can write into /etc/nginx without being root over
  // SSH. The dir is created defensively so brand-new layouts work.
  const dir = remotePath.replace(/\/[^/]+$/, '') || '/';
  const remoteCmd =
    `set -e; sudo mkdir -p ${shellQuote(dir)}; ` +
    `sudo tee ${shellQuote(remotePath)} > /dev/null`;
  const r = await execCapture(
    'ssh',
    [...sshBaseArgs(a), remoteCmd],
    content,
  );
  if (r.code !== 0) {
    throw new Error(
      `ssh ${a.user}@${a.host} write ${remotePath} failed (exit ${r.code}): ${r.stderr.trim()}`,
    );
  }
}

async function sshExec(
  a: ProxyAccess,
  remoteCmd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await execCapture('ssh', [...sshBaseArgs(a), remoteCmd]);
}
