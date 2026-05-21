import { LoggerService } from '@backstage/backend-plugin-api';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID, randomBytes } from 'crypto';

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
  database: { name: string; user: string };
  resources: { cpu: number; memory: number; storage: number };
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
  if (cfg.privateKeyFile) {
    args.push('--ssh-key', cfg.privateKeyFile);
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
  if (proxy.sshKeyPath && proxy.sshKeyPath.trim() !== '') {
    args.push('--proxy-ssh-key', proxy.sshKeyPath.trim());
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
  cfg: OrchestratorConfig,
  inst: PersistedInstance,
  logger: LoggerService,
): Promise<void> {
  if (!cfg.stateFile) return;
  try {
    await fs.mkdir(path.dirname(cfg.stateFile), { recursive: true });
    let existing: PersistedInstance[] = [];
    try {
      const raw = await fs.readFile(cfg.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as PersistedInstance[];
    } catch {
      // File missing or unreadable — start fresh.
    }
    // De-dupe on id.
    const filtered = existing.filter(e => e.id !== inst.id);
    filtered.push(inst);
    await fs.writeFile(cfg.stateFile, JSON.stringify(filtered, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    logger.warn(
      `DHIS2: failed to persist instance to ${cfg.stateFile}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export class ProvisionService {
  constructor(
    private readonly logger: LoggerService,
    private readonly cfg: OrchestratorConfig | null,
  ) {}

  isConfigured(): boolean {
    return this.cfg !== null;
  }

  async listInstances(): Promise<PersistedInstance[]> {
    if (!this.cfg?.stateFile) return [];
    try {
      const raw = await fs.readFile(this.cfg.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PersistedInstance[]) : [];
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
        database: { name: req.database.name, user: req.database.user },
        resources: req.resources,
        created: job.startedAt,
        updated: job.finishedAt,
      };
      job.instance = inst;
      appendLine(job, `[backend] provision-instance.sh exited 0`);
      await appendInstanceToState(cfg, inst, this.logger);
    } else {
      job.status = 'failed';
      job.error = `provision-instance.sh exited with code ${exitCode}`;
      appendLine(job, `[backend] ${job.error}`);
    }
  }
}
