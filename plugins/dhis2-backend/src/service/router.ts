import { LoggerService, HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { Client } from 'pg';
import { ProvisionService, ProvisionRequest } from './provisionService';
import { InstanceRegistryService } from './instanceRegistryService';
import {
  DatabaseTransferService,
  DbEndpoint,
  TransferOptions,
} from './databaseTransferService';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  provisionService: ProvisionService;
  databaseTransferService: DatabaseTransferService;
  instanceRegistryService: InstanceRegistryService;
}

interface DbCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

const CONNECT_TIMEOUT_MS = 15_000;
const STATEMENT_TIMEOUT_MS = 10_000;

function parseCredentials(body: unknown): DbCredentials {
  if (!body || typeof body !== 'object') {
    throw new InputError('Request body must be a JSON object');
  }
  const { host, port, user, password } = body as Record<string, unknown>;

  if (typeof host !== 'string' || host.trim() === '') {
    throw new InputError('"host" is required');
  }
  const portNum =
    typeof port === 'number'
      ? port
      : typeof port === 'string' && port !== ''
        ? Number(port)
        : NaN;
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    throw new InputError('"port" must be an integer between 1 and 65535');
  }
  if (typeof user !== 'string' || user.trim() === '') {
    throw new InputError('"user" is required');
  }
  if (typeof password !== 'string' || password === '') {
    throw new InputError('"password" is required');
  }

  return { host: host.trim(), port: portNum, user: user.trim(), password };
}

async function withClient<T>(
  creds: DbCredentials,
  database: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Browser-supplied creds; never reuse across requests.
    application_name: 'backstage-dhis2-plugin',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function describeError(
  err: unknown,
  creds: DbCredentials,
): { message: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    const rawMessage =
      typeof e.message === 'string' && e.message !== ''
        ? e.message
        : 'Failed to connect to PostgreSQL';
    const code = typeof e.code === 'string' ? e.code : undefined;

    // Translate common low-level errors into actionable hints. PG client
    // surfaces these as plain Error messages without an SQLSTATE code, so we
    // pattern-match on the message text.
    const target = `${creds.host}:${creds.port}`;
    const lower = rawMessage.toLowerCase();
    let message = rawMessage;
    if (lower.includes('timeout expired') || code === 'ETIMEDOUT') {
      message = `Connection to ${target} timed out after ${CONNECT_TIMEOUT_MS / 1000}s. The Backstage backend host could not reach PostgreSQL — check that the port is open from this host (firewall / security group) and that PostgreSQL is listening on ${creds.host} (postgresql.conf: listen_addresses).`;
    } else if (code === 'ECONNREFUSED' || lower.includes('econnrefused')) {
      message = `Connection to ${target} was refused. PostgreSQL is not listening on that host/port, or a firewall is rejecting the connection.`;
    } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || lower.includes('getaddrinfo')) {
      message = `Hostname ${creds.host} could not be resolved by the Backstage backend (DNS).`;
    } else if (code === 'EHOSTUNREACH' || lower.includes('ehostunreach')) {
      message = `Host ${creds.host} is unreachable from the Backstage backend (network/route).`;
    } else if (
      lower.includes('no pg_hba.conf entry') ||
      lower.includes('password authentication failed') ||
      code === '28000' ||
      code === '28P01'
    ) {
      // pg_hba or bad password — leave server message but prepend context.
      message = `${rawMessage} (PostgreSQL rejected the connection for ${creds.user}@${target}; check pg_hba.conf and the password).`;
    }
    return { message, code };
  }
  return { message: 'Failed to connect to PostgreSQL' };
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const {
    logger,
    httpAuth,
    provisionService,
    databaseTransferService,
    instanceRegistryService,
  } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Require an authenticated user for every operational route. Credentials
  // are taken from the request body (typed into the Create dialog) and never
  // logged.
  router.use(async (req, _res, next) => {
    try {
      await httpAuth.credentials(req, { allow: ['user'] });
      next();
    } catch (err) {
      next(err);
    }
  });

  router.post('/databases/test', async (req, res) => {
    const creds = parseCredentials(req.body);
    const started = Date.now();
    try {
      const version = await withClient(creds, 'postgres', async client => {
        const result = await client.query<{ version: string }>(
          'SELECT version() AS version',
        );
        return result.rows[0]?.version ?? 'unknown';
      });
      logger.info(
        `DHIS2: PG connection OK to ${creds.host}:${creds.port} as ${creds.user} (${Date.now() - started}ms)`,
      );
      res.json({
        ok: true,
        message: `Connected to ${creds.host}:${creds.port} (${version})`,
        serverVersion: version,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const { message, code } = describeError(err, creds);
      logger.warn(
        `DHIS2: PG connection FAILED to ${creds.host}:${creds.port} as ${creds.user}: ${message}${code ? ` [${code}]` : ''}`,
      );
      res.status(200).json({
        ok: false,
        message,
        code,
        durationMs: Date.now() - started,
      });
    }
  });

  router.post('/databases/list', async (req, res) => {
    const creds = parseCredentials(req.body);
    try {
      const databases = await withClient(creds, 'postgres', async client => {
        const result = await client.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1',
        );
        return result.rows.map(r => r.datname);
      });
      res.json({ databases });
    } catch (err) {
      const { message, code } = describeError(err, creds);
      logger.warn(
        `DHIS2: listDatabases FAILED on ${creds.host}:${creds.port} as ${creds.user}: ${message}${code ? ` [${code}]` : ''}`,
      );
      res.status(502).json({ error: message, code });
    }
  });

  // ---------------------------------------------------------------------
  // Instance provisioning
  // ---------------------------------------------------------------------

  function parseProvisionRequest(body: unknown): ProvisionRequest {
    if (!body || typeof body !== 'object') {
      throw new InputError('Request body must be a JSON object');
    }
    const b = body as Record<string, any>;
    const required = [
      'name',
      'domain',
      'version',
      'node',
      'vmid',
      'hostname',
      'email',
      'resources',
      'database',
    ];
    for (const key of required) {
      if (b[key] === undefined || b[key] === null || b[key] === '') {
        throw new InputError(`"${key}" is required`);
      }
    }
    const vmid = Number(b.vmid);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      throw new InputError('"vmid" must be a positive integer');
    }
    const r = b.resources;
    if (
      !r ||
      typeof r !== 'object' ||
      typeof r.cpu !== 'number' ||
      typeof r.memory !== 'number' ||
      typeof r.storage !== 'number'
    ) {
      throw new InputError('"resources" must have numeric cpu/memory/storage');
    }
    const d = b.database;
    if (
      !d ||
      typeof d.name !== 'string' ||
      typeof d.user !== 'string' ||
      typeof d.password !== 'string'
    ) {
      throw new InputError('"database" must have name/user/password strings');
    }
    return {
      name: String(b.name),
      domain: String(b.domain),
      version: String(b.version),
      node: String(b.node),
      vmid,
      hostname: String(b.hostname),
      email: String(b.email),
      resources: { cpu: r.cpu, memory: r.memory, storage: r.storage },
      database: {
        name: d.name,
        user: d.user,
        password: d.password,
        host:
          typeof d.host === 'string' && d.host.trim() !== ''
            ? d.host.trim()
            : undefined,
        port:
          typeof d.port === 'number' && Number.isInteger(d.port) && d.port > 0
            ? d.port
            : undefined,
        existing: d.existing === true ? true : undefined,
      },
      databaseAdmin:
        b.databaseAdmin &&
        typeof b.databaseAdmin === 'object' &&
        typeof b.databaseAdmin.user === 'string' &&
        typeof b.databaseAdmin.password === 'string'
          ? {
              user: b.databaseAdmin.user,
              password: b.databaseAdmin.password,
            }
          : undefined,
      adminPassword:
        typeof b.adminPassword === 'string' && b.adminPassword !== ''
          ? b.adminPassword
          : undefined,
      rootPassword:
        typeof b.rootPassword === 'string' && b.rootPassword !== ''
          ? b.rootPassword
          : undefined,
      newDbAccount:
        b.newDbAccount &&
        typeof b.newDbAccount.user === 'string' &&
        typeof b.newDbAccount.password === 'string'
          ? { user: b.newDbAccount.user, password: b.newDbAccount.password }
          : undefined,
      skipCertbot: b.skipCertbot === true,
      deleteIfExists: b.deleteIfExists === true,
      tomcatVersion:
        typeof b.tomcatVersion === 'string' && b.tomcatVersion !== ''
          ? b.tomcatVersion
          : undefined,
      // Optional per-request Proxmox API credentials forwarded from the
      // ProxmoxClusterPanel saved settings. Each field is independently
      // optional \u2014 anything left blank falls back to the orchestrator
      // config / PROXMOX_* env vars on the backend.
      proxmox:
        b.proxmox && typeof b.proxmox === 'object'
          ? {
              apiUrl:
                typeof b.proxmox.apiUrl === 'string'
                  ? b.proxmox.apiUrl
                  : undefined,
              apiUser:
                typeof b.proxmox.apiUser === 'string'
                  ? b.proxmox.apiUser
                  : undefined,
              apiTokenId:
                typeof b.proxmox.apiTokenId === 'string'
                  ? b.proxmox.apiTokenId
                  : undefined,
              apiTokenSecret:
                typeof b.proxmox.apiTokenSecret === 'string'
                  ? b.proxmox.apiTokenSecret
                  : undefined,
              validateApiCerts:
                typeof b.proxmox.validateApiCerts === 'boolean'
                  ? b.proxmox.validateApiCerts
                  : undefined,
            }
          : undefined,
      // Optional reverse-proxy server overrides forwarded from the DHIS2
      // Reverse Proxy panel (or per-instance overrides on the Create
      // Instance dialog). Without this passthrough Phase 5 always fell
      // back to the PVE host because the router silently dropped the
      // `proxy` field from the request body.
      proxy:
        b.proxy && typeof b.proxy === 'object'
          ? {
              host:
                typeof b.proxy.host === 'string' ? b.proxy.host : undefined,
              sshPort:
                typeof b.proxy.sshPort === 'number' &&
                Number.isInteger(b.proxy.sshPort) &&
                b.proxy.sshPort > 0
                  ? b.proxy.sshPort
                  : undefined,
              sshUser:
                typeof b.proxy.sshUser === 'string'
                  ? b.proxy.sshUser
                  : undefined,
              sshKeyPath:
                typeof b.proxy.sshKeyPath === 'string'
                  ? b.proxy.sshKeyPath
                  : undefined,
              nginxConfigPath:
                typeof b.proxy.nginxConfigPath === 'string'
                  ? b.proxy.nginxConfigPath
                  : undefined,
              nginxReloadCommand:
                typeof b.proxy.nginxReloadCommand === 'string'
                  ? b.proxy.nginxReloadCommand
                  : undefined,
            }
          : undefined,
    };
  }

  router.post('/instances/provision', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml (host defaults to localhost; user, privateKeyFile, scriptPath default for localhost; apiUrl, apiUser, apiTokenId, apiTokenSecret must be supplied).',
      });
      return;
    }
    let payload;
    try {
      payload = parseProvisionRequest(req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    const job = provisionService.startJob(payload);
    logger.info(
      `DHIS2: provision job ${job.id} started for ${payload.name} (vmid=${payload.vmid}, node=${payload.node})`,
    );
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  router.get('/instances/jobs/:id', (req, res) => {
    const job = provisionService.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  router.get('/instances', async (_req, res) => {
    const instances = await instanceRegistryService.listEnriched();
    res.json({ instances });
  });

  router.get('/instances/reconcile', async (_req, res) => {
    const report = await instanceRegistryService.reconcile();
    res.json(report);
  });

  // ---------------------------------------------------------------------
  // Database transfer (pg_dump | psql) between source and target servers
  // ---------------------------------------------------------------------

  function parseEndpoint(label: string, raw: unknown): DbEndpoint {
    if (!raw || typeof raw !== 'object') {
      throw new InputError(`"${label}" must be an object`);
    }
    const o = raw as Record<string, unknown>;
    const host = typeof o.host === 'string' ? o.host.trim() : '';
    const portRaw = o.port;
    const portNum =
      typeof portRaw === 'number'
        ? portRaw
        : typeof portRaw === 'string' && portRaw !== ''
          ? Number(portRaw)
          : NaN;
    const user = typeof o.user === 'string' ? o.user.trim() : '';
    const password = typeof o.password === 'string' ? o.password : '';
    const database = typeof o.database === 'string' ? o.database.trim() : '';
    if (!host) throw new InputError(`"${label}.host" is required`);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      throw new InputError(`"${label}.port" must be an integer between 1 and 65535`);
    }
    if (!user) throw new InputError(`"${label}.user" is required`);
    if (!password) throw new InputError(`"${label}.password" is required`);
    if (!database) throw new InputError(`"${label}.database" is required`);
    return { host, port: portNum, user, password, database };
  }

  function parseTransferOptions(raw: unknown): TransferOptions {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') {
      throw new InputError('"options" must be an object');
    }
    const o = raw as Record<string, unknown>;
    const opts: TransferOptions = {};
    if (typeof o.createTargetDatabase === 'boolean')
      opts.createTargetDatabase = o.createTargetDatabase;
    if (typeof o.dropTargetIfExists === 'boolean')
      opts.dropTargetIfExists = o.dropTargetIfExists;
    if (typeof o.noOwner === 'boolean') opts.noOwner = o.noOwner;
    if (typeof o.noPrivileges === 'boolean') opts.noPrivileges = o.noPrivileges;
    if (typeof o.clean === 'boolean') opts.clean = o.clean;
    if (
      typeof o.maintenanceDatabase === 'string' &&
      o.maintenanceDatabase.trim() !== ''
    ) {
      opts.maintenanceDatabase = o.maintenanceDatabase.trim();
    }
    return opts;
  }

  router.post('/instances/:id/transfer-database', async (req, res) => {
    const instanceId = String(req.params.id);
    let source: DbEndpoint;
    let target: DbEndpoint;
    let options: TransferOptions;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      source = parseEndpoint('source', body.source);
      target = parseEndpoint('target', body.target);
      options = parseTransferOptions(body.options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    try {
      const job = await databaseTransferService.startJob({
        instanceId,
        source,
        target,
        options,
      });
      logger.info(
        `DHIS2: transfer job ${job.id} started for instance ${instanceId} (${source.database}@${source.host} \u2192 ${target.database}@${target.host})`,
      );
      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get('/databases/transfers/:id', (req, res) => {
    const job = databaseTransferService.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Transfer job not found' });
      return;
    }
    res.json(job);
  });

  return router;
}
