import { LoggerService, HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { Client } from 'pg';
import {
  ProvisionService,
  ProvisionRequest,
  DecommissionRequest,
  EditRequest,
} from './provisionService';
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

  // ---------------------------------------------------------------------
  // POST /restore/upload — stage a DHIS2 database dump for restore.
  //
  // The frontend posts the raw file bytes as `application/octet-stream`
  // with an `X-Filename` header carrying the original name. The body
  // streams straight to a per-token file under the staging directory;
  // `express.json()` (above) is a no-op for non-JSON content types so
  // the request body remains available as a Node stream on `req`.
  // ---------------------------------------------------------------------
  router.post('/restore/upload', async (req, res, next) => {
    try {
      if (!provisionService.isConfigured()) {
        res.status(503).json({
          error:
            'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml.',
        });
        return;
      }
      const rawName =
        (typeof req.header('x-filename') === 'string'
          ? (req.header('x-filename') as string)
          : '') || 'upload.bin';
      const filename = rawName.replace(/[\r\n\0]/g, '').slice(-256);
      const result = await provisionService.stageRestoreUpload(req, filename);
      res.status(200).json(result);
    } catch (err) {
      logger.error(
        `DHIS2: restore upload failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

  router.post('/instances/next-vmid', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml (host defaults to localhost; user, privateKeyFile, scriptPath default for localhost; apiUrl, apiUser, apiTokenId, apiTokenSecret must be supplied).',
      });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, any>)
        : {};
    const pm =
      b.proxmox && typeof b.proxmox === 'object'
        ? (b.proxmox as Record<string, any>)
        : {};
    try {
      const vmid = await provisionService.getNextVmid({
        apiUrl: typeof pm.apiUrl === 'string' ? pm.apiUrl.trim() : undefined,
        apiUser: typeof pm.apiUser === 'string' ? pm.apiUser.trim() : undefined,
        apiTokenId:
          typeof pm.apiTokenId === 'string' ? pm.apiTokenId.trim() : undefined,
        apiTokenSecret:
          typeof pm.apiTokenSecret === 'string'
            ? pm.apiTokenSecret
            : undefined,
        validateApiCerts:
          typeof pm.validateApiCerts === 'boolean'
            ? pm.validateApiCerts
            : undefined,
      });
      res.json({ vmid });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: next-vmid failed: ${message}`);
      res.status(502).json({ error: message });
    }
  });

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
      proxyOverride:
        b.proxyOverride && typeof b.proxyOverride === 'object'
          ? {
              mode:
                typeof b.proxyOverride.mode === 'string'
                  ? b.proxyOverride.mode
                  : undefined,
              baseDomain:
                typeof b.proxyOverride.baseDomain === 'string'
                  ? b.proxyOverride.baseDomain
                  : undefined,
              pathPrefix:
                typeof b.proxyOverride.pathPrefix === 'string'
                  ? b.proxyOverride.pathPrefix
                  : undefined,
            }
          : undefined,
      restore:
        b.restore && typeof b.restore === 'object'
          ? (b.restore as Record<string, unknown>)
          : undefined,
      proxySettings:
        b.proxySettings && typeof b.proxySettings === 'object'
          ? {
              mode:
                typeof b.proxySettings.mode === 'string'
                  ? b.proxySettings.mode
                  : undefined,
              baseDomain:
                typeof b.proxySettings.baseDomain === 'string'
                  ? b.proxySettings.baseDomain
                  : undefined,
              pathPrefix:
                typeof b.proxySettings.pathPrefix === 'string'
                  ? b.proxySettings.pathPrefix
                  : undefined,
              host:
                typeof b.proxySettings.host === 'string'
                  ? b.proxySettings.host
                  : undefined,
              sshPort:
                typeof b.proxySettings.sshPort === 'number' &&
                Number.isInteger(b.proxySettings.sshPort) &&
                b.proxySettings.sshPort > 0
                  ? b.proxySettings.sshPort
                  : undefined,
              sshUser:
                typeof b.proxySettings.sshUser === 'string'
                  ? b.proxySettings.sshUser
                  : undefined,
              sshKeyPath:
                typeof b.proxySettings.sshKeyPath === 'string'
                  ? b.proxySettings.sshKeyPath
                  : undefined,
              nginxConfigPath:
                typeof b.proxySettings.nginxConfigPath === 'string'
                  ? b.proxySettings.nginxConfigPath
                  : undefined,
              nginxReloadCommand:
                typeof b.proxySettings.nginxReloadCommand === 'string'
                  ? b.proxySettings.nginxReloadCommand
                  : undefined,
              sslProvider:
                typeof b.proxySettings.sslProvider === 'string'
                  ? b.proxySettings.sslProvider
                  : undefined,
              letsencryptEmail:
                typeof b.proxySettings.letsencryptEmail === 'string'
                  ? b.proxySettings.letsencryptEmail
                  : undefined,
              sslCertPath:
                typeof b.proxySettings.sslCertPath === 'string'
                  ? b.proxySettings.sslCertPath
                  : undefined,
              sslKeyPath:
                typeof b.proxySettings.sslKeyPath === 'string'
                  ? b.proxySettings.sslKeyPath
                  : undefined,
              forceHttps:
                typeof b.proxySettings.forceHttps === 'boolean'
                  ? b.proxySettings.forceHttps
                  : undefined,
              enableHsts:
                typeof b.proxySettings.enableHsts === 'boolean'
                  ? b.proxySettings.enableHsts
                  : undefined,
              upstreamPort:
                typeof b.proxySettings.upstreamPort === 'number' &&
                Number.isInteger(b.proxySettings.upstreamPort) &&
                b.proxySettings.upstreamPort > 0
                  ? b.proxySettings.upstreamPort
                  : undefined,
            }
          : undefined,
      dhis2Settings:
        b.dhis2Settings && typeof b.dhis2Settings === 'object'
          ? {
              defaultVersion:
                typeof b.dhis2Settings.defaultVersion === 'string'
                  ? b.dhis2Settings.defaultVersion
                  : undefined,
              javaHeap:
                typeof b.dhis2Settings.javaHeap === 'string'
                  ? b.dhis2Settings.javaHeap
                  : undefined,
              tomcatPort:
                typeof b.dhis2Settings.tomcatPort === 'number' &&
                Number.isInteger(b.dhis2Settings.tomcatPort)
                  ? b.dhis2Settings.tomcatPort
                  : undefined,
              defaultCpu:
                typeof b.dhis2Settings.defaultCpu === 'number' &&
                Number.isInteger(b.dhis2Settings.defaultCpu)
                  ? b.dhis2Settings.defaultCpu
                  : undefined,
              defaultMemoryMb:
                typeof b.dhis2Settings.defaultMemoryMb === 'number' &&
                Number.isInteger(b.dhis2Settings.defaultMemoryMb)
                  ? b.dhis2Settings.defaultMemoryMb
                  : undefined,
              defaultStorageGb:
                typeof b.dhis2Settings.defaultStorageGb === 'number' &&
                Number.isInteger(b.dhis2Settings.defaultStorageGb)
                  ? b.dhis2Settings.defaultStorageGb
                  : undefined,
              postgresHost:
                typeof b.dhis2Settings.postgresHost === 'string'
                  ? b.dhis2Settings.postgresHost
                  : undefined,
              postgresPort:
                typeof b.dhis2Settings.postgresPort === 'number' &&
                Number.isInteger(b.dhis2Settings.postgresPort)
                  ? b.dhis2Settings.postgresPort
                  : undefined,
              postgresAdminUser:
                typeof b.dhis2Settings.postgresAdminUser === 'string'
                  ? b.dhis2Settings.postgresAdminUser
                  : undefined,
              postgresAdminPassword:
                typeof b.dhis2Settings.postgresAdminPassword === 'string'
                  ? b.dhis2Settings.postgresAdminPassword
                  : undefined,
              backupEnabled:
                typeof b.dhis2Settings.backupEnabled === 'boolean'
                  ? b.dhis2Settings.backupEnabled
                  : undefined,
              backupSchedule:
                typeof b.dhis2Settings.backupSchedule === 'string'
                  ? b.dhis2Settings.backupSchedule
                  : undefined,
              backupRetentionDays:
                typeof b.dhis2Settings.backupRetentionDays === 'number' &&
                Number.isInteger(b.dhis2Settings.backupRetentionDays)
                  ? b.dhis2Settings.backupRetentionDays
                  : undefined,
              backupBucket:
                typeof b.dhis2Settings.backupBucket === 'string'
                  ? b.dhis2Settings.backupBucket
                  : undefined,
            }
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

  // ---------------------------------------------------------------------
  // Instance decommission (delete) — Ansible-backed, streamed log
  // ---------------------------------------------------------------------
  function parseDecommissionRequest(
    instanceId: string,
    body: unknown,
    instance: {
      name: string;
      vmid: string;
      node: string;
      domain: string;
      database: { name: string; user: string };
    },
  ): DecommissionRequest {
    const b = (body && typeof body === 'object' ? body : {}) as Record<
      string,
      any
    >;
    const vmidNum = Number(instance.vmid);
    if (!Number.isInteger(vmidNum) || vmidNum <= 0) {
      throw new InputError(
        `Persisted instance has invalid vmid "${instance.vmid}"`,
      );
    }
    const proxy = (b.proxy && typeof b.proxy === 'object' ? b.proxy : {}) as Record<
      string,
      any
    >;
    const dbOverride =
      b.database && typeof b.database === 'object'
        ? (b.database as Record<string, any>)
        : {};
    const dbAdmin =
      b.databaseAdmin && typeof b.databaseAdmin === 'object'
        ? (b.databaseAdmin as Record<string, any>)
        : {};
    const proxmox =
      b.proxmox && typeof b.proxmox === 'object'
        ? (b.proxmox as Record<string, any>)
        : {};
    return {
      instanceId,
      vmid: vmidNum,
      node: instance.node,
      domain: instance.domain,
      name: instance.name,
      skipProxyCleanup: Boolean(b.skipProxyCleanup),
      dropDatabase: Boolean(b.dropDatabase),
      database: {
        name:
          typeof dbOverride.name === 'string' && dbOverride.name.trim() !== ''
            ? dbOverride.name.trim()
            : instance.database.name,
        user:
          typeof dbOverride.user === 'string' && dbOverride.user.trim() !== ''
            ? dbOverride.user.trim()
            : instance.database.user,
        host:
          typeof dbOverride.host === 'string' ? dbOverride.host.trim() : undefined,
        port:
          typeof dbOverride.port === 'number'
            ? dbOverride.port
            : typeof dbOverride.port === 'string' && dbOverride.port !== ''
              ? Number(dbOverride.port)
              : undefined,
      },
      databaseAdmin: {
        user: typeof dbAdmin.user === 'string' ? dbAdmin.user.trim() : undefined,
        password:
          typeof dbAdmin.password === 'string' ? dbAdmin.password : undefined,
      },
      proxy: {
        host: typeof proxy.host === 'string' ? proxy.host.trim() : undefined,
        sshPort:
          typeof proxy.sshPort === 'number'
            ? proxy.sshPort
            : typeof proxy.sshPort === 'string' && proxy.sshPort !== ''
              ? Number(proxy.sshPort)
              : undefined,
        sshUser:
          typeof proxy.sshUser === 'string' ? proxy.sshUser.trim() : undefined,
        sshKeyPath:
          typeof proxy.sshKeyPath === 'string'
            ? proxy.sshKeyPath.trim()
            : undefined,
        nginxConfigPath:
          typeof proxy.nginxConfigPath === 'string'
            ? proxy.nginxConfigPath.trim()
            : undefined,
        nginxReloadCommand:
          typeof proxy.nginxReloadCommand === 'string'
            ? proxy.nginxReloadCommand.trim()
            : undefined,
      },
      proxmox: {
        apiUrl:
          typeof proxmox.apiUrl === 'string' ? proxmox.apiUrl.trim() : undefined,
        apiUser:
          typeof proxmox.apiUser === 'string'
            ? proxmox.apiUser.trim()
            : undefined,
        apiTokenId:
          typeof proxmox.apiTokenId === 'string'
            ? proxmox.apiTokenId.trim()
            : undefined,
        apiTokenSecret:
          typeof proxmox.apiTokenSecret === 'string'
            ? proxmox.apiTokenSecret
            : undefined,
        validateApiCerts:
          typeof proxmox.validateApiCerts === 'boolean'
            ? proxmox.validateApiCerts
            : undefined,
      },
    };
  }

  router.post('/instances/:id/decommission', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml.',
      });
      return;
    }
    const instanceId = req.params.id;
    const persisted = await provisionService.listInstances();
    const found = persisted.find(i => i.id === instanceId);
    if (!found) {
      res.status(404).json({ error: `Instance ${instanceId} not found` });
      return;
    }
    let payload: DecommissionRequest;
    try {
      payload = parseDecommissionRequest(instanceId, req.body, {
        name: found.name,
        vmid: found.vmid,
        node: found.node,
        domain: found.domain,
        database: found.database,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    const job = provisionService.startDecommissionJob(payload);
    logger.info(
      `DHIS2: decommission job ${job.id} started for ${payload.name} (vmid=${payload.vmid}, node=${payload.node})`,
    );
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  // ---------------------------------------------------------------------
  // Instance edit (apply changes) — Ansible-backed, streamed log
  // ---------------------------------------------------------------------
  function parseEditRequest(
    instanceId: string,
    body: unknown,
    instance: {
      name: string;
      vmid: string;
      node: string;
      domain: string;
      version: string;
      database: { name: string; user: string };
      resources: { cpu: number; memory: number; storage: number };
    },
  ): EditRequest {
    const b = (body && typeof body === 'object' ? body : {}) as Record<
      string,
      any
    >;
    const vmidNum = Number(instance.vmid);
    if (!Number.isInteger(vmidNum) || vmidNum <= 0) {
      throw new InputError(
        `Persisted instance has invalid vmid "${instance.vmid}"`,
      );
    }

    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    const num = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };

    const resObj =
      b.resources && typeof b.resources === 'object'
        ? (b.resources as Record<string, any>)
        : {};
    const cpu = num(resObj.cpu) ?? instance.resources.cpu;
    const memory = num(resObj.memory) ?? instance.resources.memory;
    const storage = num(resObj.storage) ?? instance.resources.storage;
    for (const [k, v] of [
      ['cpu', cpu],
      ['memory', memory],
      ['storage', storage],
    ] as const) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new InputError(`Invalid resource value for ${k}: ${v}`);
      }
    }

    const dbObj =
      b.database && typeof b.database === 'object'
        ? (b.database as Record<string, any>)
        : {};
    const dbPassword = typeof dbObj.password === 'string' ? dbObj.password : '';
    if (dbPassword.length === 0) {
      throw new InputError(
        'database.password is required so dhis.conf can be re-rendered with the correct credential.',
      );
    }

    const proxy =
      b.proxy && typeof b.proxy === 'object'
        ? (b.proxy as Record<string, any>)
        : {};
    const proxmox =
      b.proxmox && typeof b.proxmox === 'object'
        ? (b.proxmox as Record<string, any>)
        : {};

    const restartTomcat =
      typeof b.restartTomcat === 'boolean' ? b.restartTomcat : true;

    return {
      instanceId,
      vmid: vmidNum,
      node: instance.node,
      domain: instance.domain,
      name: str(b.name) ?? instance.name,
      version: str(b.version) ?? instance.version,
      resources: { cpu, memory, storage },
      database: {
        name: str(dbObj.name) ?? instance.database.name,
        user: str(dbObj.user) ?? instance.database.user,
        host: str(dbObj.host),
        port: num(dbObj.port),
        password: dbPassword,
      },
      restartTomcat,
      proxy: {
        host: str(proxy.host),
        sshPort: num(proxy.sshPort),
        sshUser: str(proxy.sshUser),
        sshKeyPath: str(proxy.sshKeyPath),
      },
      proxmox: {
        apiUrl: str(proxmox.apiUrl),
        apiUser: str(proxmox.apiUser),
        apiTokenId: str(proxmox.apiTokenId),
        apiTokenSecret:
          typeof proxmox.apiTokenSecret === 'string'
            ? proxmox.apiTokenSecret
            : undefined,
        validateApiCerts:
          typeof proxmox.validateApiCerts === 'boolean'
            ? proxmox.validateApiCerts
            : undefined,
      },
    };
  }

  router.post('/instances/:id/edit', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml.',
      });
      return;
    }
    const instanceId = req.params.id;
    const persisted = await provisionService.listInstances();
    const found = persisted.find(i => i.id === instanceId);
    if (!found) {
      res.status(404).json({ error: `Instance ${instanceId} not found` });
      return;
    }
    let payload: EditRequest;
    try {
      payload = parseEditRequest(instanceId, req.body, {
        name: found.name,
        vmid: found.vmid,
        node: found.node,
        domain: found.domain,
        version: found.version,
        database: found.database,
        resources: found.resources,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    const job = provisionService.startEditJob(payload);
    logger.info(
      `DHIS2: edit job ${job.id} started for ${payload.name} (vmid=${payload.vmid}, node=${payload.node})`,
    );
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  // ---------------------------------------------------------------------
  // Per-instance nginx proxy files (upstream snippet + vhost / dhis.conf)
  // ---------------------------------------------------------------------
  function parseProxyAccessOverrides(
    body: unknown,
  ): {
    host?: string;
    sshPort?: number;
    sshUser?: string;
    sshKeyPath?: string;
    nginxConfigPath?: string;
    nginxReloadCommand?: string;
    sitesAvailable?: string;
  } {
    if (!body || typeof body !== 'object') return {};
    const b = body as Record<string, unknown>;
    const proxy =
      b.proxy && typeof b.proxy === 'object'
        ? (b.proxy as Record<string, unknown>)
        : {};
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;
    const port =
      typeof proxy.sshPort === 'number' &&
      Number.isInteger(proxy.sshPort) &&
      proxy.sshPort > 0
        ? proxy.sshPort
        : undefined;
    return {
      host: str(proxy.host),
      sshPort: port,
      sshUser: str(proxy.sshUser),
      sshKeyPath: str(proxy.sshKeyPath),
      nginxConfigPath: str(proxy.nginxConfigPath),
      nginxReloadCommand: str(proxy.nginxReloadCommand),
      sitesAvailable: str(proxy.sitesAvailable),
    };
  }

  router.post('/instances/:id/proxy-files/read', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    try {
      const result = await provisionService.readProxyFiles(
        req.params.id,
        parseProxyAccessOverrides(req.body),
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: proxy-files read failed: ${message}`);
      res.status(400).json({ error: message });
    }
  });

  router.post('/instances/:id/proxy-files/write', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    const upstream =
      typeof b.upstream === 'string' ? (b.upstream as string) : undefined;
    const site =
      typeof b.site === 'string' ? (b.site as string) : undefined;
    if (upstream === undefined && site === undefined) {
      res
        .status(400)
        .json({ error: 'Provide "upstream" and/or "site" string fields.' });
      return;
    }
    try {
      const result = await provisionService.writeProxyFiles(
        req.params.id,
        parseProxyAccessOverrides(req.body),
        { upstream, site, reload: b.reload !== false },
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: proxy-files write failed: ${message}`);
      res.status(400).json({ error: message });
    }
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
