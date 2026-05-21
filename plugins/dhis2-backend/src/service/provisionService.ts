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
  /** Proxmox API endpoint, e.g. "pve01.example.com" or "pve01:8006". */
  apiHost: string;
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
  database: { name: string; user: string; password: string };
  /**
   * Initial DHIS2 admin password. Optional — when omitted or blank, the
   * backend generates a strong random password and emits it once into the
   * job log so the operator can copy it.
   */
  adminPassword?: string;
  rootPassword?: string;
  newDbAccount?: { user: string; password: string };
  skipCertbot?: boolean;
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
  if (cfg.skipCertbot || req.skipCertbot) {
    args.push('--skip-certbot');
  }
  // The provision script also needs an SSH key (used by Ansible to talk to
  // the freshly-created LXC). Reuse the orchestrator key when configured so
  // operators don't have to wire the same path in two places.
  if (cfg.privateKeyFile) {
    args.push('--ssh-key', cfg.privateKeyFile);
  }
  // Secrets + Proxmox API credentials go via env vars, NEVER on argv.
  const env: Record<string, string> = {
    DHIS2_DB_PASS: req.database.password,
    DHIS2_ADMIN_PASS: req.adminPassword ?? '',
    ROOT_PASSWORD: req.rootPassword ?? req.adminPassword ?? '',
    PROXMOX_API_HOST: cfg.apiHost,
    PROXMOX_API_USER: cfg.apiUser,
    PROXMOX_API_TOKEN_ID: cfg.apiTokenId,
    PROXMOX_API_TOKEN_SECRET: cfg.apiTokenSecret,
    PROXMOX_VALIDATE_CERTS: cfg.validateApiCerts ? 'true' : 'false',
  };
  if (req.newDbAccount?.password) {
    env.NEW_DB_PASS = req.newDbAccount.password;
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
      `[backend] Running provision-instance.sh locally on the Backstage host. Proxmox API: ${cfg.apiUser}@${cfg.apiHost} (LXC lifecycle via REST; nginx via SSH to ${resolvePveHost(cfg, req) || 'localhost'}).`,
    );

    const command = buildCommand(cfg, req);
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
