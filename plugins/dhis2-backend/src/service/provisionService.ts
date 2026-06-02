import { LoggerService } from '@backstage/backend-plugin-api';
import { spawn } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, randomBytes } from 'crypto';
import {
  DHIS2_TAGS,
  ProxmoxApiCredentials,
  getNextClusterVmid,
  ensureLxcTags,
} from './proxmoxApi';
import { InstanceStore } from './instanceStore';

type ProxmoxOverride = {
  apiUrl?: string;
  apiUser?: string;
  apiTokenId?: string;
  apiTokenSecret?: string;
  validateApiCerts?: boolean;
};

/**
 * Configuration for the host that runs provision-instance.sh.
 *
 * In the API-based flow this host is the Backstage backend itself: the
 * script renders an Ansible playbook that drives Proxmox via the REST API
 * (community.general.proxmox) — no `pct`/`pvesh` CLI is required and the
 * Backstage host does NOT need to be a Proxmox node.
 *
 * The legacy `host` / `user` / `privateKeyFile` fields are still consumed
 * by configure-proxy.sh (which SSHes to the PVE host to install the
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
   * configure-proxy.sh). When omitted, falls back to host (if
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

  /**
   * Absolute directory on the orchestrator host used to stage uploaded
   * DHIS2 database dumps (`POST /restore/upload`). Each upload is written
   * to a uuid-named file under this directory and referenced by an
   * opaque upload token. Defaults to `${os.tmpdir()}/dhis2-restore-staging`.
   */
  restoreStagingDir?: string;
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
   * When true, the bash orchestrator scans the Proxmox cluster for any
   * LXC with a matching hostname (regardless of VMID) and purges each
   * before invoking the create-LXC step. The frontend gates this behind
   * the same confirmation prompt used by `deleteIfExists`.
   */
  deleteIfNameExists?: boolean;
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
  /** Skip the configure-proxy.sh --remove step. */
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
 * Shape the frontend sends to POST /instances/:id/lifecycle.
 *
 * Drives a start / stop / restart of the underlying LXC via the
 * Proxmox REST API (no in-container SSH). Same job-runner pattern as
 * Edit / Decommission: returns a job id immediately and streams the
 * playbook output into the activity log.
 */
export interface LifecycleRequest {
  instanceId: string;
  vmid: number;
  node: string;
  /** Same form used by provision-instance.sh: '<fqdn>' or '<fqdn>/<segment>'. */
  domain: string;
  /** Human-readable instance name — only used for log lines / job echo. */
  name: string;
  action: 'start' | 'stop' | 'restart';
  /** Seconds to wait for graceful shutdown / reboot (default 60). */
  shutdownTimeout?: number;
  /** Force a hard stop if graceful shutdown times out (default true). */
  forceStop?: boolean;
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
}

/**
 * Shape the frontend sends to POST /instances/:id/clone.
 *
 * Drives a Proxmox-level LXC clone of an existing instance plus the
 * follow-up reconfiguration (DB strategy, dhis.conf rewrite, nginx
 * vhost) so the clone is independently usable as a dev / test /
 * staging environment.
 */
export interface CloneRequest {
  /** Persisted id of the SOURCE instance. */
  sourceInstanceId: string;
  /** Source VMID / node / hostname / db.name resolved from the registry. */
  source: {
    vmid: number;
    node: string;
    hostname: string;
    dbHost: string;
    dbPort: number;
    dbName: string;
  };
  /** Display name for the new instance (registered in the store on success). */
  name: string;
  /** Target Proxmox node + VMID. */
  vmid: number;
  node: string;
  /** Container hostname for the clone (often same as `name`). */
  hostname: string;
  /** Same form used by provision-instance.sh: '<fqdn>' or '<fqdn>/<segment>'. */
  domain: string;
  /** Optional new DHIS2 version label written into the registry. */
  version?: string;
  resources: { cpu: number; memory: number; storage: number };
  /**
   * DB strategy:
   *   - 'colocated'    — source DB lives in source LXC; `pct clone` copies it
   *                      automatically; no remote DB work is performed.
   *   - 'shared-clone' — source DB lives on a shared remote Postgres; create
   *                      `<dbName>` via `CREATE DATABASE … TEMPLATE <src>` +
   *                      a new role with its own password.
   *   - 'shared-keep'  — clone keeps pointing at the source DB. The UI must
   *                      warn the operator before submitting.
   */
  dbStrategy: 'colocated' | 'shared-clone' | 'shared-keep';
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    /** Required so dhis.conf can be rendered with the correct credential. */
    password: string;
  };
  /** Admin role on the shared PG server (only used for 'shared-clone'). */
  databaseAdmin?: { user?: string; password?: string };
  /** Briefly shutdown source for a consistent clone (default true). */
  pauseSource?: boolean;
  /** Seconds to wait for the graceful source shutdown (default 60). */
  shutdownTimeout?: number;
  /** When false, render dhis.conf but skip the Tomcat restart. */
  restartTomcat?: boolean;
  /** SSH details for the PVE host (used for pct push / pct exec). */
  proxy?: {
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
  };
  /** Skip Let's Encrypt cert request on the new vhost. */
  skipCertbot?: boolean;
  /** Contact email passed to certbot (when not skipped). */
  email?: string;
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
}

/**
 * Shape the frontend sends to POST /instances/:id/upgrade.
 *
 * Replaces the deployed DHIS2 WAR inside an existing LXC with a newer
 * release (or a pre-staged local file), keeping the same container,
 * database, and reverse-proxy vhost. The orchestrator stops Tomcat,
 * archives the current WAR (and optionally pg_dumps the DB) under
 * /opt/dhis2/backups/pre-upgrade-<ts>/ inside the LXC, pushes the new
 * WAR, and starts Tomcat back up with a health probe.
 *
 * On success the persisted instance record's `version` field is updated
 * to `toVersion` so the catalog UI reflects the new release immediately.
 */
export interface UpgradeRequest {
  /** Persisted id of the instance being upgraded. */
  instanceId: string;
  vmid: number;
  node: string;
  /** Container hostname (only used for log lines). */
  hostname: string;
  /** Display name (used in log lines / STEP_DONE). */
  name: string;
  /** '<fqdn>' or '<fqdn>/<segment>' — picks ROOT.war vs <segment>.war. */
  domain: string;
  /** Target DHIS2 version label (e.g. '2.41.3' or '41.2.0'). */
  toVersion: string;
  /** Optional explicit WAR URL. When empty the playbook derives it from toVersion. */
  warUrl?: string;
  /** Optional pre-staged WAR path on the PVE host. Takes precedence over warUrl. */
  warFile?: string;
  /** When false, skip the pre-upgrade pg_dump snapshot. Default true. */
  backupDb?: boolean;
  /** Keep newest N pre-upgrade backup dirs inside the LXC. Default 3. */
  backupRetain?: number;
  /** Override the Tomcat systemd unit (default "tomcat"). */
  tomcatService?: string;
  /** Override the Tomcat webapps dir (default "/opt/tomcat/webapps"). */
  webappsDir?: string;
  /** Database connection used by pg_dump when backupDb is true. */
  database?: {
    host?: string;
    port?: number;
    name?: string;
    user?: string;
    password?: string;
  };
  /** SSH details for the PVE host (used for pct push / pct exec). */
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
  restoreSpecPath?: string,
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
  if (restoreSpecPath) {
    args.push('--restore-spec', restoreSpecPath);
  }
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
  if (req.deleteIfNameExists) {
    args.push('--delete-if-name-exists');
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

function buildLifecycleCommand(
  cfg: OrchestratorConfig,
  req: LifecycleRequest,
  scriptPath: string,
): string {
  const args: string[] = [
    scriptPath,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--action', req.action,
  ];
  if (
    typeof req.shutdownTimeout === 'number' &&
    Number.isInteger(req.shutdownTimeout) &&
    req.shutdownTimeout > 0
  ) {
    args.push('--shutdown-timeout', String(req.shutdownTimeout));
  }
  if (req.forceStop === false) {
    args.push('--no-force-stop');
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

function buildCloneCommand(
  cfg: OrchestratorConfig,
  req: CloneRequest,
  scriptPath: string,
): string {
  // Mirror resolvePveHost(): explicit override > cfg.host (if not local)
  // > target node hostname.
  let pveHost: string;
  if (cfg.pveHost !== undefined) {
    pveHost = cfg.pveHost;
  } else if (cfg.host && !isLocalHost(cfg.host)) {
    pveHost = cfg.host;
  } else {
    pveHost = req.node;
  }

  const proxy = req.proxy ?? {};
  const args: string[] = [
    scriptPath,
    '--src-vmid', String(req.source.vmid),
    '--src-node', req.source.node,
    '--src-hostname', req.source.hostname,
    '--src-db-name', req.source.dbName,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--hostname', req.hostname,
    '--instance-name', req.name,
    '--domain', req.domain,
    '--cpu', String(req.resources.cpu),
    '--memory', String(req.resources.memory),
    '--storage', String(req.resources.storage),
    '--version', req.version ?? '',
    '--db-strategy', req.dbStrategy,
    '--db-host', req.database.host,
    '--db-port', String(req.database.port || 5432),
    '--db-name', req.database.name,
    '--db-user', req.database.user,
  ];
  if (
    typeof req.shutdownTimeout === 'number' &&
    Number.isInteger(req.shutdownTimeout) &&
    req.shutdownTimeout > 0
  ) {
    args.push('--shutdown-timeout', String(req.shutdownTimeout));
  }
  if (req.pauseSource === false) {
    args.push('--no-pause-source');
  }
  if (req.restartTomcat === false) {
    args.push('--no-restart-tomcat');
  }

  // SSH details for pct push/exec (target PVE host).
  args.push('--pve-host', proxy.host ?? pveHost);
  if (typeof proxy.sshPort === 'number') {
    args.push('--pve-port', String(proxy.sshPort));
  }
  if (proxy.sshUser) args.push('--pve-user', proxy.sshUser);
  if (proxy.sshKeyPath) args.push('--pve-ssh-key', proxy.sshKeyPath);
  // The central nginx reverse-proxy host shares the same SSH details.
  args.push('--proxy-host', proxy.host ?? pveHost);
  if (typeof proxy.sshPort === 'number') {
    args.push('--proxy-port', String(proxy.sshPort));
  }
  if (proxy.sshUser) args.push('--proxy-user', proxy.sshUser);
  if (proxy.sshKeyPath) args.push('--proxy-ssh-key', proxy.sshKeyPath);
  if (proxy.nginxConfigPath) {
    args.push('--proxy-upstream-dir', proxy.nginxConfigPath);
  }
  if (proxy.nginxReloadCommand) {
    args.push('--proxy-nginx-reload', proxy.nginxReloadCommand);
  }
  if (req.skipCertbot) args.push('--skip-certbot');
  if (req.email) args.push('--email', req.email);

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
  if (req.dbStrategy === 'shared-clone') {
    const admin = req.databaseAdmin ?? {};
    if (admin.user) env.DHIS2_DB_ADMIN_USER = admin.user;
    if (admin.password) env.DHIS2_DB_ADMIN_PASS = admin.password;
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

function buildUpgradeCommand(
  cfg: OrchestratorConfig,
  req: UpgradeRequest,
  scriptPath: string,
): string {
  // Same resolvePveHost() fallback ladder used by clone/lifecycle.
  let pveHost: string;
  if (cfg.pveHost !== undefined) {
    pveHost = cfg.pveHost;
  } else if (cfg.host && !isLocalHost(cfg.host)) {
    pveHost = cfg.host;
  } else {
    pveHost = req.node;
  }

  const proxy = req.proxy ?? {};
  const db = req.database ?? {};
  const backupDb = req.backupDb !== false;

  const args: string[] = [
    scriptPath,
    '--vmid', String(req.vmid),
    '--node', req.node,
    '--hostname', req.hostname,
    '--instance-name', req.name,
    '--domain', req.domain,
    '--to-version', req.toVersion,
  ];
  if (req.warUrl && req.warUrl.trim() !== '') {
    args.push('--war-url', req.warUrl.trim());
  }
  if (req.warFile && req.warFile.trim() !== '') {
    args.push('--war-file', req.warFile.trim());
  }
  if (!backupDb) {
    args.push('--no-backup-db');
  }
  if (
    typeof req.backupRetain === 'number' &&
    Number.isInteger(req.backupRetain) &&
    req.backupRetain > 0
  ) {
    args.push('--backup-retain', String(req.backupRetain));
  }
  if (req.tomcatService && req.tomcatService.trim() !== '') {
    args.push('--tomcat-service', req.tomcatService.trim());
  }
  if (req.webappsDir && req.webappsDir.trim() !== '') {
    args.push('--webapps-dir', req.webappsDir.trim());
  }
  if (db.host && db.host.trim() !== '') {
    args.push('--db-host', db.host.trim());
  }
  if (
    typeof db.port === 'number' &&
    Number.isInteger(db.port) &&
    db.port > 0
  ) {
    args.push('--db-port', String(db.port));
  }
  if (db.name && db.name.trim() !== '') {
    args.push('--db-name', db.name.trim());
  }
  if (db.user && db.user.trim() !== '') {
    args.push('--db-user', db.user.trim());
  }

  args.push('--pve-host', proxy.host ?? pveHost);
  if (typeof proxy.sshPort === 'number') {
    args.push('--pve-port', String(proxy.sshPort));
  }
  if (proxy.sshUser) args.push('--pve-user', proxy.sshUser);
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
  };
  if (backupDb && db.password) {
    env.DHIS2_DB_PASS = db.password;
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
  /**
   * In-memory registry of staged dump uploads, keyed by opaque token.
   * Entries are written to `cfg.restoreStagingDir` and removed after a
   * successful provisioning consumes them (or via TTL on next list).
   */
  private readonly uploads = new Map<
    string,
    { stagedPath: string; sizeBytes: number; originalFilename: string; expiresAt: number }
  >();

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
    const provisionScriptName = path.basename(cfg.scriptPath);
    appendLine(
      job,
      `[backend] Running ${provisionScriptName} locally on the Backstage host. Proxmox API: ${cfg.apiUser}@${cfg.apiUrl} (LXC lifecycle via REST; nginx via SSH to ${resolvePveHost(cfg, req) || 'localhost'}).`,
    );

    // -------------------------------------------------------------------
    // Restore spec materialisation: translate req.restore into the JSON
    // shape consumed by create-instance.sh --restore-spec, write to a
    // tempfile, and pass the path on argv. The temp file (and any staged
    // upload it references) is cleaned up after the job exits.
    // -------------------------------------------------------------------
    let restoreSpecPath: string | undefined;
    let uploadTokenToConsume: string | undefined;
    try {
      const translated = await this.translateRestoreSource(req.restore);
      if (translated) {
        const stagingDir = await this.resolveRestoreStagingDir();
        restoreSpecPath = path.join(stagingDir, `restore-spec-${job.id}.json`);
        await fs.writeFile(restoreSpecPath, JSON.stringify(translated), {
          mode: 0o600,
        });
        appendLine(
          job,
          `[backend] Restore source kind=${translated.kind} prepared at ${restoreSpecPath}`,
        );
        if (translated.kind === 'upload' && req.restore) {
          uploadTokenToConsume = String(
            (req.restore as any).uploadToken ?? '',
          );
        }
      }
    } catch (err) {
      job.status = 'failed';
      job.error = `restore-spec preparation failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      return;
    }

    const command = buildCommand(cfg, req, restoreSpecPath);
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
      appendLine(job, `[backend] ${provisionScriptName} exited 0`);
      await appendInstanceToState(this.instanceStore, inst, this.logger);
      // Best-effort: tag the new LXC so reconciliation can verify it
      // belongs to this plugin. Non-fatal — a tagging failure only loses
      // the secondary marker, the registry entry is already persisted.
      await this.tagInstance(job, req).catch(err => {
        appendLine(
          job,
          `[backend] WARN: failed to tag LXC ${req.vmid} on ${req.node}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } else {
      job.status = 'failed';
      job.error = `${provisionScriptName} exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }

    // Clean up the rendered restore spec + any consumed upload token,
    // regardless of job outcome. Best-effort; never let cleanup mask the
    // real job result.
    if (restoreSpecPath) {
      await fs.unlink(restoreSpecPath).catch(() => {});
    }
    await this.consumeUploadToken(uploadTokenToConsume);
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
   * Start a lifecycle (start / stop / restart) job. Returns the job id
   * immediately; the wrapper script runs asynchronously and streams
   * stdout/stderr into the job's log buffer (same pattern as
   * `startJob` / `startEditJob` / `startDecommissionJob`).
   */
  startLifecycleJob(req: LifecycleRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Lifecycle actions are not configured. Set dhis2.orchestrator in app-config.yaml.',
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

    this.runLifecycleJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(`DHIS2: lifecycle job ${id} crashed: ${job.error}`);
    });

    return snapshot(job);
  }

  private async runLifecycleJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: LifecycleRequest,
  ): Promise<void> {
    job.status = 'running';
    const lifecycleScript = path.join(
      path.dirname(cfg.scriptPath),
      'lifecycle-instance.sh',
    );
    appendLine(
      job,
      `[backend] Running lifecycle-instance.sh locally on the Backstage host for instance "${req.name}" (vmid=${req.vmid}, node=${req.node}, action=${req.action}).`,
    );

    const command = buildLifecycleCommand(cfg, req, lifecycleScript);
    appendLine(
      job,
      `[backend] Executing: ${lifecycleScript} --vmid ${req.vmid} --node ${req.node} --action ${req.action} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();

    if (exitCode === 0) {
      job.status = 'success';
      appendLine(job, `[backend] lifecycle-instance.sh exited 0`);
      // Persist the new runtime status so the registry reflects the
      // action even before the next Proxmox reconcile picks it up.
      try {
        const inst = await this.findInstance(req.instanceId);
        if (inst) {
          const newStatus: PersistedInstance['status'] =
            req.action === 'stop' ? 'stopped' : 'running';
          if (inst.status !== newStatus) {
            await this.instanceStore.upsert({ ...inst, status: newStatus });
          }
        }
      } catch (err) {
        appendLine(
          job,
          `[backend] WARN: failed to persist new status: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      job.status = 'failed';
      job.error = `lifecycle-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }
  }

  /**
   * Start a clone job: duplicate an existing instance into a new LXC and
   * reconfigure DB + nginx vhost so the clone is independently usable as
   * a dev / test / staging environment. Returns the job id immediately.
   *
   * On success the new instance is persisted via `instanceStore.upsert`
   * exactly like `runJob` does for fresh provisions.
   */
  startCloneJob(req: CloneRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Clone is not configured. Set dhis2.orchestrator in app-config.yaml.',
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
        version: req.version ?? '',
        node: req.node,
        vmid: req.vmid,
      },
    };
    jobs.set(id, job);

    this.runCloneJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(`DHIS2: clone job ${id} crashed: ${job.error}`);
    });

    return snapshot(job);
  }

  private async runCloneJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: CloneRequest,
  ): Promise<void> {
    job.status = 'running';
    const cloneScript = path.join(
      path.dirname(cfg.scriptPath),
      'clone-instance.sh',
    );
    appendLine(
      job,
      `[backend] Cloning instance "${req.source.hostname}" (vmid=${req.source.vmid}, node=${req.source.node}) -> "${req.name}" (vmid=${req.vmid}, node=${req.node}, db_strategy=${req.dbStrategy}).`,
    );

    const command = buildCloneCommand(cfg, req, cloneScript);
    appendLine(
      job,
      `[backend] Executing: ${cloneScript} --src-vmid ${req.source.vmid} --vmid ${req.vmid} --node ${req.node} --hostname ${req.hostname} --domain ${req.domain} --db-strategy ${req.dbStrategy} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();

    if (exitCode !== 0) {
      job.status = 'failed';
      job.error = `clone-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
      return;
    }

    job.status = 'success';
    appendLine(job, `[backend] clone-instance.sh exited 0`);

    // Register the clone in the persisted instance store so it shows up
    // alongside other DHIS2 instances. Mirrors the create-flow upsert in
    // runJob().
    const inst: PersistedInstance = {
      id: `dhis2-${req.vmid}`,
      name: req.name,
      vmid: String(req.vmid),
      node: req.node,
      status: 'running',
      version: req.version ?? '',
      url: `https://${req.domain}`,
      domain: req.domain,
      database: {
        name: req.database.name,
        user: req.database.user,
        host: req.database.host,
        port: req.database.port,
        password: req.database.password,
        existing: req.dbStrategy === 'shared-keep',
      },
      resources: req.resources,
      created: job.startedAt,
      updated: job.finishedAt,
    };
    job.instance = inst;
    await appendInstanceToState(this.instanceStore, inst, this.logger);
  }

  /**
   * Start an upgrade job: swap the DHIS2 WAR inside an existing LXC for
   * a newer release (or a pre-staged local file). Returns the job id
   * immediately; the persisted instance record's `version` field is
   * updated to `toVersion` on success.
   */
  startUpgradeJob(req: UpgradeRequest): JobSnapshot {
    if (!this.cfg) {
      throw new Error(
        'Upgrade is not configured. Set dhis2.orchestrator in app-config.yaml.',
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
        version: req.toVersion,
        node: req.node,
        vmid: req.vmid,
      },
    };
    jobs.set(id, job);

    this.runUpgradeJob(job, cfg, req).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      appendLine(job, `[backend] FATAL: ${job.error}`);
      this.logger.error(`DHIS2: upgrade job ${id} crashed: ${job.error}`);
    });

    return snapshot(job);
  }

  private async runUpgradeJob(
    job: JobSnapshot,
    cfg: OrchestratorConfig,
    req: UpgradeRequest,
  ): Promise<void> {
    job.status = 'running';
    const upgradeScript = path.join(
      path.dirname(cfg.scriptPath),
      'upgrade-instance.sh',
    );
    appendLine(
      job,
      `[backend] Upgrading instance "${req.name}" (vmid=${req.vmid}, node=${req.node}) -> DHIS2 ${req.toVersion}.`,
    );

    const command = buildUpgradeCommand(cfg, req, upgradeScript);
    appendLine(
      job,
      `[backend] Executing: ${upgradeScript} --vmid ${req.vmid} --node ${req.node} --hostname ${req.hostname} --domain ${req.domain} --to-version ${req.toVersion}${
        req.warFile ? ` --war-file ${req.warFile}` : ''
      }${req.warUrl ? ` --war-url ${req.warUrl}` : ''} (secrets via env)`,
    );

    const exitCode = await runLocal(job, command);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();

    if (exitCode !== 0) {
      job.status = 'failed';
      job.error = `upgrade-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
      return;
    }

    job.status = 'success';
    appendLine(job, `[backend] upgrade-instance.sh exited 0`);

    // Persist the new version so the catalog UI reflects the upgrade.
    const updated = await updateInstanceInState(
      this.instanceStore,
      req.instanceId,
      { version: req.toVersion, updated: job.finishedAt },
      this.logger,
    );
    if (updated) {
      job.instance = updated;
      appendLine(
        job,
        `[backend] Persisted instance ${req.instanceId} version -> ${req.toVersion}.`,
      );
    } else {
      appendLine(
        job,
        `[backend] WARN: instance ${req.instanceId} not found in registry — version not persisted.`,
      );
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

  async getNextVmid(overrides?: ProxmoxOverride): Promise<number> {
    const creds = this.resolveEffectiveProxmoxCredentials(overrides);
    if (!creds) {
      throw new Error(
        'Proxmox API credentials are not configured. Set dhis2.orchestrator.{apiUrl,apiUser,apiTokenId,apiTokenSecret}.',
      );
    }
    return await getNextClusterVmid(creds);
  }

  private resolveEffectiveProxmoxCredentials(
    overrides?: ProxmoxOverride,
  ): ProxmoxApiCredentials | null {
    if (!this.cfg) return null;
    const cfg = this.cfg;
    const reqPm = overrides ?? {};
    const apiUrl = (reqPm.apiUrl && reqPm.apiUrl.trim()) || cfg.apiUrl;
    const { apiUser, apiTokenId } = normalizeProxmoxCreds(
      (reqPm.apiUser && reqPm.apiUser.trim()) || cfg.apiUser,
      (reqPm.apiTokenId && reqPm.apiTokenId.trim()) || cfg.apiTokenId,
    );
    const apiTokenSecret =
      (reqPm.apiTokenSecret && reqPm.apiTokenSecret.trim()) ||
      cfg.apiTokenSecret;
    if (!apiUrl || !apiUser || !apiTokenId || !apiTokenSecret) {
      return null;
    }
    const validateCerts =
      typeof reqPm.validateApiCerts === 'boolean'
        ? reqPm.validateApiCerts && Boolean(cfg.validateApiCerts)
        : Boolean(cfg.validateApiCerts);
    return { apiUrl, apiUser, apiTokenId, apiTokenSecret, validateCerts };
  }

  private async tagInstance(
    job: JobSnapshot,
    req: ProvisionRequest,
  ): Promise<void> {
    const creds = this.resolveEffectiveProxmoxCredentials(req.proxmox);
    if (!creds) {
      appendLine(
        job,
        `[backend] Skipping Proxmox tag step: API credentials not configured.`,
      );
      return;
    }
    const tags = DHIS2_TAGS.split(';');
    const applied = await ensureLxcTags(
      creds,
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
  // configure-proxy.sh and delete-instance.sh use.

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

  /**
   * Tail the live DHIS2 / Tomcat log files inside an instance LXC.
   *
   * Runs `pct exec <vmid> -- tail -n N <path>` on the PVE host that owns
   * the container. When the orchestrator runs colocated with PVE we exec
   * directly; otherwise we SSH into the PVE host using the same access
   * ladder used by lifecycle/clone (`cfg.pveHost` override -> `cfg.host`
   * if non-local -> per-instance `node`).
   *
   * `source`:
   *   - 'dhis2'    -> /opt/tomcat/logs/dhis.log (Log4j2 application log)
   *   - 'catalina' -> /opt/tomcat/logs/catalina.out (Tomcat stdout)
   *   - 'auto'     -> dhis.log when present, else catalina.out (default)
   */
  async tailInstanceLogs(
    instanceId: string,
    opts: {
      source?: 'dhis2' | 'catalina' | 'auto';
      lines?: number;
      /** Optional explicit PVE SSH host override (rarely needed). */
      pveHost?: string;
      pveSshPort?: number;
      pveSshUser?: string;
      pveSshKeyPath?: string;
    } = {},
  ): Promise<{ source: string; path: string; lines: string[] }> {
    if (!this.cfg) throw new Error('Orchestrator not configured.');
    const cfg = this.cfg;
    const inst = await this.findInstance(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found.`);

    const vmidStr = String(inst.vmid).trim();
    if (!/^\d+$/.test(vmidStr)) {
      throw new Error(`Refusing to tail logs: vmid "${vmidStr}" is not numeric.`);
    }
    const requested = Number.isFinite(opts.lines) ? Number(opts.lines) : 200;
    const lines = Math.max(1, Math.min(5000, Math.floor(requested)));
    const source = opts.source ?? 'auto';

    const DHIS_LOG = '/opt/tomcat/logs/dhis.log';
    const CATALINA_LOG = '/opt/tomcat/logs/catalina.out';

    // Build the remote shell snippet that runs *inside the LXC*. It picks
    // the right file based on `source` and falls back when 'auto'.
    let pickAndTail: string;
    if (source === 'dhis2') {
      pickAndTail =
        `f=${shellQuote(DHIS_LOG)}; ` +
        `if [ -f "$f" ]; then echo "===> $f" >&2; tail -n ${lines} "$f"; ` +
        `else echo "Log file $f not found inside the container." >&2; exit 2; fi`;
    } else if (source === 'catalina') {
      pickAndTail =
        `f=${shellQuote(CATALINA_LOG)}; ` +
        `if [ -f "$f" ]; then echo "===> $f" >&2; tail -n ${lines} "$f"; ` +
        `else echo "Log file $f not found inside the container." >&2; exit 2; fi`;
    } else {
      pickAndTail =
        `for f in ${shellQuote(DHIS_LOG)} ${shellQuote(CATALINA_LOG)}; do ` +
        `if [ -f "$f" ]; then echo "===> $f" >&2; tail -n ${lines} "$f"; exit 0; fi; ` +
        `done; echo "Neither dhis.log nor catalina.out was found under /opt/tomcat/logs." >&2; exit 2`;
    }

    // `pct exec <vmid> -- bash -lc <snippet>` runs the snippet inside the
    // container. `pct` only exists on the PVE host itself.
    const pctCmd = `pct exec ${vmidStr} -- bash -lc ${shellQuote(pickAndTail)}`;

    // Resolve PVE SSH target — same ladder as resolvePveHost(), with
    // optional per-request overrides for ad-hoc situations.
    const pveHost =
      (opts.pveHost && opts.pveHost.trim()) ||
      (cfg.pveHost !== undefined ? cfg.pveHost : '') ||
      (cfg.host && !isLocalHost(cfg.host) ? cfg.host : '') ||
      inst.node;
    const runRemote = !!pveHost && !isLocalHost(pveHost);

    let result: { code: number; stdout: string; stderr: string };
    if (runRemote) {
      const access: ProxyAccess = {
        host: pveHost,
        port:
          opts.pveSshPort && Number.isInteger(opts.pveSshPort) && opts.pveSshPort > 0
            ? opts.pveSshPort
            : cfg.port || 22,
        user: (opts.pveSshUser && opts.pveSshUser.trim()) || cfg.user || 'root',
        keyPath:
          normalizeSshPrivateKeyPath(opts.pveSshKeyPath) ||
          normalizeSshPrivateKeyPath(cfg.privateKeyFile) ||
          undefined,
      };
      result = await sshExec(access, pctCmd);
    } else {
      result = await execCapture('bash', ['-lc', pctCmd]);
    }

    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `Failed to read logs from vmid ${vmidStr}` +
          (msg ? `: ${msg}` : ` (exit ${result.code}).`),
      );
    }

    // Strip the "===> path" marker we printed to stderr, then split.
    const stderr = (result.stderr || '').trim();
    const pathMatch = stderr.match(/===>\s+(\S+)/);
    const usedPath =
      pathMatch?.[1] ??
      (source === 'catalina' ? CATALINA_LOG : DHIS_LOG);

    const out = result.stdout.replace(/\r\n/g, '\n');
    const splitLines = out.length > 0 ? out.split('\n') : [];
    // tail output usually ends with a trailing newline -> drop the empty tail.
    if (splitLines.length > 0 && splitLines[splitLines.length - 1] === '') {
      splitLines.pop();
    }

    return {
      source: source === 'auto' ? (usedPath === DHIS_LOG ? 'dhis2' : 'catalina') : source,
      path: usedPath,
      lines: splitLines,
    };
  }

  /**
   * pg_dump the instance's database to a local file on the Backstage
   * backend host. Used by the Delete dialog as a safety-net snapshot
   * before the LXC + database are destroyed.
   *
   * Requires the database to be reachable from the Backstage host
   * (i.e. a shared/remote PostgreSQL host) and `pg_dump` to be on PATH.
   * Returns the absolute path of the written `.dump` (pg_dump custom
   * format) along with its size.
   */
  async backupInstanceDatabase(
    instanceId: string,
    opts: {
      dbHost?: string;
      dbPort?: number;
      dbName?: string;
      dbUser?: string;
      dbPassword?: string;
    } = {},
  ): Promise<{
    path: string;
    sizeBytes: number;
    database: string;
    host: string;
    durationMs: number;
  }> {
    if (!this.cfg) throw new Error('Orchestrator not configured.');
    const inst = await this.findInstance(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found.`);

    const dbHost = (opts.dbHost ?? inst.database.host ?? '').trim();
    const dbPort = opts.dbPort ?? inst.database.port ?? 5432;
    const dbName = (opts.dbName ?? inst.database.name ?? '').trim();
    const dbUser = (opts.dbUser ?? inst.database.user ?? '').trim();
    const dbPassword = opts.dbPassword ?? inst.database.password ?? '';

    if (!dbHost || ['localhost', '127.0.0.1', '::1'].includes(dbHost.toLowerCase())) {
      throw new Error(
        'Pre-delete pg_dump requires a remote PostgreSQL host reachable from the Backstage backend; this instance uses a database local to its LXC.',
      );
    }
    if (!dbName || !dbUser) {
      throw new Error('Database name and user are required for pg_dump.');
    }
    if (!dbPassword) {
      throw new Error(
        'No stored password for this instance — cannot pg_dump. Re-enter credentials in the Edit dialog and retry.',
      );
    }

    // Pre-flight: pg_dump on PATH.
    const preflight = await execCapture('bash', [
      '-lc',
      'command -v pg_dump >/dev/null',
    ]);
    if (preflight.code !== 0) {
      throw new Error(
        'pg_dump is not installed on the Backstage backend host. Install the postgresql-client package and retry.',
      );
    }

    const backupsDir =
      (this.cfg.restoreStagingDir &&
        path.join(path.dirname(this.cfg.restoreStagingDir), 'dhis2-backups')) ||
      path.join(os.tmpdir(), 'dhis2-backups');
    await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 });

    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '');
    const safeName = (inst.name || inst.id).replace(/[^A-Za-z0-9._-]/g, '_');
    const outPath = path.join(
      backupsDir,
      `${safeName}-${dbName}-pre-delete-${ts}.dump`,
    );

    const env: Record<string, string> = {
      PGPASSWORD: dbPassword,
    };
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const cmd =
      `${envPrefix} pg_dump --no-password -Fc ` +
      `-h ${shellQuote(dbHost)} -p ${String(dbPort)} ` +
      `-U ${shellQuote(dbUser)} -d ${shellQuote(dbName)} ` +
      `-f ${shellQuote(outPath)}`;

    const started = Date.now();
    const result = await execCapture('bash', ['-lc', cmd]);
    if (result.code !== 0) {
      await fs.unlink(outPath).catch(() => {});
      const msg = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `pg_dump failed (exit ${result.code})` + (msg ? `: ${msg}` : ''),
      );
    }
    const stat = await fs.stat(outPath);
    return {
      path: outPath,
      sizeBytes: stat.size,
      database: dbName,
      host: dbHost,
      durationMs: Date.now() - started,
    };
  }

  private async findInstance(id: string): Promise<PersistedInstance | null> {
    const list = await this.listInstances();
    return list.find(i => i.id === id) ?? null;
  }

  // -----------------------------------------------------------------------
  // Restore upload staging
  // -----------------------------------------------------------------------

  /** Resolve the on-disk staging directory, creating it on first use. */
  private async resolveRestoreStagingDir(): Promise<string> {
    const dir =
      (this.cfg?.restoreStagingDir && this.cfg.restoreStagingDir.trim()) ||
      path.join(os.tmpdir(), 'dhis2-restore-staging');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    return dir;
  }

  /** TTL for upload tokens before the staging file is garbage-collected. */
  private static readonly UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

  /** Drop tokens whose staging files have expired (best-effort). */
  private async sweepExpiredUploads(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [token, entry] of this.uploads) {
      if (entry.expiresAt <= now) expired.push(token);
    }
    for (const token of expired) {
      const entry = this.uploads.get(token);
      this.uploads.delete(token);
      if (entry) {
        await fs.unlink(entry.stagedPath).catch(() => {});
      }
    }
  }

  /**
   * Stream an uploaded dump file to the staging directory and return an
   * opaque token the frontend uses when submitting `RestoreSource` of
   * kind `upload`.
   */
  async stageRestoreUpload(
    body: Readable,
    originalFilename: string,
  ): Promise<{ uploadToken: string; sizeBytes: number; expiresAt: string }> {
    await this.sweepExpiredUploads();
    const dir = await this.resolveRestoreStagingDir();
    const safeBase = originalFilename
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(-128) || 'upload.bin';
    const token = randomUUID();
    const stagedPath = path.join(dir, `${token}__${safeBase}`);
    const sink = createWriteStream(stagedPath, { mode: 0o600 });
    let sizeBytes = 0;
    body.on('data', (chunk: Buffer) => {
      sizeBytes += chunk.length;
    });
    await new Promise<void>((resolve, reject) => {
      body.on('error', reject);
      sink.on('error', reject);
      sink.on('close', resolve);
      body.pipe(sink);
    });
    const expiresAtMs = Date.now() + ProvisionService.UPLOAD_TTL_MS;
    this.uploads.set(token, {
      stagedPath,
      sizeBytes,
      originalFilename,
      expiresAt: expiresAtMs,
    });
    this.logger.info(
      `DHIS2: staged restore upload token=${token} size=${sizeBytes} path=${stagedPath}`,
    );
    return {
      uploadToken: token,
      sizeBytes,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Translate the frontend `RestoreSource` (already wire-typed as a
   * `Record<string, unknown>` on `ProvisionRequest.restore`) into the
   * JSON spec consumed by `create-instance.sh --restore-spec` and then
   * forwarded verbatim (with a few rename/synthesis rules) to the
   * Ansible `dhis2_restore` extra-var.
   *
   * Returns `null` when the source is missing/unrecognised so the caller
   * can simply skip writing a spec file.
   *
   * Throws `Error` with a human-readable message when the source is
   * present but unusable (e.g. unknown upload token, missing source
   * instance for `kind: instance`).
   */
  async translateRestoreSource(
    source: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | null> {
    if (!source || typeof source !== 'object') return null;
    const kind = String((source as any).kind ?? '').trim();
    if (!kind) return null;
    const fmt =
      typeof (source as any).format === 'string'
        ? ((source as any).format as string)
        : undefined;
    switch (kind) {
      case 'upload': {
        const token = String((source as any).uploadToken ?? '').trim();
        if (!token) throw new Error('restore.upload: uploadToken is required.');
        await this.sweepExpiredUploads();
        const entry = this.uploads.get(token);
        if (!entry) {
          throw new Error(
            `restore.upload: unknown or expired uploadToken=${token}. Re-upload the dump file and retry.`,
          );
        }
        return {
          kind: 'upload',
          staged_path: entry.stagedPath,
          dump_format: fmt,
          original_filename: entry.originalFilename,
        };
      }
      case 'url': {
        const url = String((source as any).url ?? '').trim();
        if (!url) throw new Error('restore.url: url is required.');
        return {
          kind: 'url',
          url,
          headers: (source as any).headers ?? undefined,
          dump_format: fmt,
        };
      }
      case 's3': {
        const bucket = String((source as any).bucket ?? '').trim();
        const key = String((source as any).key ?? '').trim();
        if (!bucket) throw new Error('restore.s3: bucket is required.');
        if (!key) throw new Error('restore.s3: key is required.');
        return {
          kind: 's3',
          bucket,
          key,
          region: (source as any).region || undefined,
          endpoint: (source as any).endpoint || undefined,
          access_key: (source as any).accessKeyId || undefined,
          secret_key: (source as any).secretAccessKey || undefined,
          dump_format: fmt,
        };
      }
      case 'instance': {
        const srcId = String((source as any).sourceInstanceId ?? '').trim();
        if (!srcId)
          throw new Error('restore.instance: sourceInstanceId is required.');
        const src = await this.findInstance(srcId);
        if (!src) {
          throw new Error(
            `restore.instance: source instance ${srcId} is not in the registry.`,
          );
        }
        const srcHost =
          src.database.host && src.database.host.trim() !== ''
            ? src.database.host.trim()
            : src.domain.split('/')[0];
        if (!srcHost) {
          throw new Error(
            `restore.instance: cannot determine database host for ${srcId}.`,
          );
        }
        if (!src.database.password) {
          throw new Error(
            `restore.instance: no stored password for source instance ${srcId} -- cannot pg_dump.`,
          );
        }
        return {
          kind: 'instance',
          source_host: srcHost,
          source_db: src.database.name,
          source_user: src.database.user,
          source_password: src.database.password,
          source_port: src.database.port ?? 5432,
        };
      }
      default:
        throw new Error(`restore: unsupported kind=${kind}.`);
    }
  }

  /**
   * Consume (delete + forget) the staged upload referenced by a token,
   * if any. Called after a provisioning job finishes (success or
   * failure) so dumps don't accumulate on disk.
   */
  private async consumeUploadToken(token: string | undefined): Promise<void> {
    if (!token) return;
    const entry = this.uploads.get(token);
    if (!entry) return;
    this.uploads.delete(token);
    await fs.unlink(entry.stagedPath).catch(() => {});
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
   * same defaults configure-proxy.sh applies.
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
