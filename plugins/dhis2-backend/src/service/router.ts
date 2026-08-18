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
  LifecycleRequest,
  CloneRequest,
  UpgradeRequest,
  deriveTomcatVersionForDhis2,
  ConflictError,
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

interface DbCompatibilityRequest extends DbCredentials {
  database: string;
  targetVersion?: string;
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

function parseCompatibilityRequest(body: unknown): DbCompatibilityRequest {
  const creds = parseCredentials(body);
  const b = body as Record<string, unknown>;
  const database =
    typeof b.database === 'string' ? b.database.trim() : '';
  if (!database) {
    throw new InputError('"database" is required');
  }

  const targetVersion =
    typeof b.targetVersion === 'string' && b.targetVersion.trim() !== ''
      ? b.targetVersion.trim()
      : undefined;

  return {
    ...creds,
    database,
    targetVersion,
  };
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

  router.post('/databases/check-compatibility', async (req, res) => {
    const request = parseCompatibilityRequest(req.body);
    try {
      const result = await withClient(
        request,
        request.database,
        async client => {
          const flywayTableResult = await client.query<{ present: boolean }>(
            `SELECT to_regclass('public.flyway_schema_history') IS NOT NULL AS present`,
          );
          const hasFlywayHistory = Boolean(flywayTableResult.rows[0]?.present);

          if (!hasFlywayHistory) {
            return {
              compatible: false,
              message:
                `Database "${request.database}" does not contain public.flyway_schema_history. ` +
                'This usually means it is not a DHIS2 schema with an upgrade path that can be validated safely.',
              details: {
                database: request.database,
                hasFlywayHistory: false,
                targetVersion: request.targetVersion,
              },
            };
          }

          const failedMigrationsResult = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM public.flyway_schema_history
             WHERE success = false`,
          );
          const failedMigrations = Number(
            failedMigrationsResult.rows[0]?.count ?? '0',
          );
          if (failedMigrations > 0) {
            return {
              compatible: false,
              message:
                `Database "${request.database}" has ${failedMigrations} failed Flyway migration(s). ` +
                'Repair the schema history or restore a clean backup before provisioning.',
              details: {
                database: request.database,
                hasFlywayHistory: true,
                failedMigrations,
                targetVersion: request.targetVersion,
              },
            };
          }

          const latestResult = await client.query<{
            version: string | null;
            description: string | null;
          }>(
            `SELECT version, description
             FROM public.flyway_schema_history
             WHERE success = true
             ORDER BY installed_rank DESC
             LIMIT 1`,
          );
          const latest = latestResult.rows[0];

          const constraintResult = await client.query<{ present: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_constraint c
               JOIN pg_namespace n ON n.oid = c.connamespace
               WHERE n.nspname = 'public'
                 AND c.conname = 'fk_organisationunit_fileresourceid'
             ) AS present`,
          );
          const migrationMarkerResult = await client.query<{ present: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM public.flyway_schema_history
               WHERE success = true AND version = '2.37.14'
             ) AS present`,
          );

          const hasKnownConstraint = Boolean(
            constraintResult.rows[0]?.present,
          );
          const hasMigrationMarker = Boolean(
            migrationMarkerResult.rows[0]?.present,
          );

          if (hasKnownConstraint && !hasMigrationMarker) {
            return {
              compatible: false,
              message:
                `Database "${request.database}" appears to have a partially-applied schema state ` +
                '(constraint fk_organisationunit_fileresourceid exists but Flyway version 2.37.14 is not recorded). ' +
                'Provisioning is likely to fail with duplicate-constraint errors.',
              details: {
                database: request.database,
                hasFlywayHistory: true,
                failedMigrations: 0,
                latestFlywayVersion: latest?.version ?? null,
                latestFlywayDescription: latest?.description ?? null,
                targetVersion: request.targetVersion,
              },
            };
          }

          const versionSuffix = latest?.version
            ? ` Last successful Flyway version: ${latest.version}.`
            : '';
          return {
            compatible: true,
            message:
              `Database "${request.database}" passed compatibility preflight.` +
              versionSuffix,
            details: {
              database: request.database,
              hasFlywayHistory: true,
              failedMigrations: 0,
              latestFlywayVersion: latest?.version ?? null,
              latestFlywayDescription: latest?.description ?? null,
              targetVersion: request.targetVersion,
            },
          };
        },
      );

      res.status(200).json({
        ok: true,
        compatible: result.compatible,
        message: result.message,
        details: result.details,
      });
    } catch (err) {
      const { message, code } = describeError(err, request);
      logger.warn(
        `DHIS2: compatibility check FAILED on ${request.host}:${request.port}/${request.database} as ${request.user}: ${message}${code ? ` [${code}]` : ''}`,
      );
      res.status(200).json({
        ok: false,
        compatible: false,
        message,
        code,
      });
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
      deleteIfNameExists: b.deleteIfNameExists === true,
      tomcatVersion: (() => {
        const raw =
          typeof b.tomcatVersion === 'string' ? b.tomcatVersion.trim() : '';
        if (raw === '9' || raw === '10') return raw as '9' | '10';
        // Auto-derive from the DHIS2 version when omitted/blank so old
        // clients (and any other caller) can't accidentally land an
        // incompatible Tomcat/DHIS2 pair: 2.40/2.41 (javax) need 9, v42+
        // (jakarta) need 10.
        return deriveTomcatVersionForDhis2(String(b.version ?? ''));
      })(),
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

    const requestedName = payload.name.trim().toLowerCase();
    const existingByName = (await provisionService.listInstances()).find(
      i => i.name.trim().toLowerCase() === requestedName,
    );
    if (existingByName) {
      res.status(409).json({
        error: `Instance name \"${existingByName.name}\" already exists (node ${existingByName.node}, vmid ${existingByName.vmid}). Choose a different name.`,
      });
      return;
    }

    let job;
    try {
      job = provisionService.startJob(payload);
    } catch (err) {
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
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

  router.post('/instances/:id/backup', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    const db =
      b.database && typeof b.database === 'object'
        ? (b.database as Record<string, unknown>)
        : {};
    const str = (v: unknown) =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    try {
      const result = await provisionService.backupInstanceDatabase(
        req.params.id,
        {
          dbHost: str(db.host),
          dbPort: num(db.port),
          dbName: str(db.name),
          dbUser: str(db.user),
          dbPassword: typeof db.password === 'string' ? db.password : undefined,
        },
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: pre-delete backup failed: ${message}`);
      res.status(400).json({ error: message });
    }
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

    const tomcatVersionRaw =
      typeof b.tomcatVersion === 'string' ? b.tomcatVersion.trim() : '';
    const tomcatVersion =
      tomcatVersionRaw === '9' || tomcatVersionRaw === '10'
        ? (tomcatVersionRaw as '9' | '10')
        : undefined;

    return {
      instanceId,
      vmid: vmidNum,
      node: instance.node,
      domain: instance.domain,
      name: str(b.name) ?? instance.name,
      version: str(b.version) ?? instance.version,
      tomcatVersion,
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
  // Instance lifecycle (start / stop / restart) — Ansible-backed, streamed log
  // ---------------------------------------------------------------------
  function parseLifecycleRequest(
    instanceId: string,
    body: unknown,
    instance: {
      name: string;
      vmid: string;
      node: string;
      domain: string;
    },
  ): LifecycleRequest {
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
    const action =
      typeof b.action === 'string' ? b.action.trim().toLowerCase() : '';
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      throw new InputError(
        `action must be one of: start, stop, restart (got "${b.action}")`,
      );
    }
    const num = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
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
      action: action as 'start' | 'stop' | 'restart',
      shutdownTimeout: num(b.shutdownTimeout),
      forceStop:
        typeof b.forceStop === 'boolean' ? b.forceStop : undefined,
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

  router.post('/instances/:id/lifecycle', async (req, res) => {
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
    let payload: LifecycleRequest;
    try {
      payload = parseLifecycleRequest(instanceId, req.body, {
        name: found.name,
        vmid: found.vmid,
        node: found.node,
        domain: found.domain,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    const job = provisionService.startLifecycleJob(payload);
    logger.info(
      `DHIS2: lifecycle job ${job.id} (${payload.action}) started for ${payload.name} (vmid=${payload.vmid}, node=${payload.node})`,
    );
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  // ---------------------------------------------------------------------
  // Clone an existing instance into a new LXC + reconfigure DB + nginx
  // ---------------------------------------------------------------------
  function parseCloneRequest(
    sourceInstanceId: string,
    body: unknown,
    source: {
      vmid: string;
      node: string;
      hostname: string;
      domain: string;
      database: {
        host?: string;
        port?: number;
        name: string;
      };
    },
  ): CloneRequest {
    const b = (body && typeof body === 'object' ? body : {}) as Record<
      string,
      any
    >;
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
    const need = (label: string, v: string | undefined): string => {
      if (!v) throw new InputError(`Missing required field: ${label}`);
      return v;
    };

    const srcVmid = Number(source.vmid);
    if (!Number.isInteger(srcVmid) || srcVmid <= 0) {
      throw new InputError(
        `Source instance has invalid vmid "${source.vmid}"`,
      );
    }

    const targetVmid = num(b.vmid);
    if (
      targetVmid === undefined ||
      !Number.isInteger(targetVmid) ||
      targetVmid <= 0
    ) {
      throw new InputError(`vmid must be a positive integer`);
    }
    if (targetVmid === srcVmid) {
      throw new InputError(`Target vmid must differ from source vmid`);
    }

    const dbStrategyRaw =
      typeof b.dbStrategy === 'string' ? b.dbStrategy.trim() : '';
    if (
      dbStrategyRaw !== 'colocated' &&
      dbStrategyRaw !== 'shared-clone' &&
      dbStrategyRaw !== 'shared-keep'
    ) {
      throw new InputError(
        `dbStrategy must be one of: colocated, shared-clone, shared-keep (got "${b.dbStrategy}")`,
      );
    }
    const dbStrategy = dbStrategyRaw as
      | 'colocated'
      | 'shared-clone'
      | 'shared-keep';

    const dbIn =
      b.database && typeof b.database === 'object'
        ? (b.database as Record<string, any>)
        : {};
    const dbHost = need(
      'database.host',
      str(dbIn.host) ?? source.database.host,
    );
    const dbPort = num(dbIn.port) ?? source.database.port ?? 5432;
    const dbName = need('database.name', str(dbIn.name));
    const dbUser = need('database.user', str(dbIn.user));
    const dbPassword = need(
      'database.password',
      typeof dbIn.password === 'string' && dbIn.password !== ''
        ? dbIn.password
        : undefined,
    );

    const adminIn =
      b.databaseAdmin && typeof b.databaseAdmin === 'object'
        ? (b.databaseAdmin as Record<string, any>)
        : {};
    if (dbStrategy === 'shared-clone') {
      if (typeof adminIn.password !== 'string' || adminIn.password === '') {
        throw new InputError(
          'databaseAdmin.password is required when dbStrategy="shared-clone"',
        );
      }
    }

    const resIn =
      b.resources && typeof b.resources === 'object'
        ? (b.resources as Record<string, any>)
        : {};
    const cpu = num(resIn.cpu);
    const memory = num(resIn.memory);
    const storage = num(resIn.storage);
    if (cpu === undefined || cpu <= 0) {
      throw new InputError('resources.cpu must be a positive integer');
    }
    if (memory === undefined || memory <= 0) {
      throw new InputError('resources.memory (MB) must be a positive integer');
    }
    if (storage === undefined || storage <= 0) {
      throw new InputError('resources.storage (GB) must be a positive integer');
    }

    const proxyIn =
      b.proxy && typeof b.proxy === 'object'
        ? (b.proxy as Record<string, any>)
        : {};
    const proxmoxIn =
      b.proxmox && typeof b.proxmox === 'object'
        ? (b.proxmox as Record<string, any>)
        : {};

    return {
      sourceInstanceId,
      source: {
        vmid: srcVmid,
        node: source.node,
        hostname: source.hostname,
        dbHost: source.database.host ?? '',
        dbPort: source.database.port ?? 5432,
        dbName: source.database.name,
      },
      name: need('name', str(b.name)),
      vmid: targetVmid,
      node: need('node', str(b.node)),
      hostname: need('hostname', str(b.hostname)),
      domain: need('domain', str(b.domain)),
      version: str(b.version),
      tomcatVersion: (() => {
        const raw =
          typeof b.tomcatVersion === 'string' ? b.tomcatVersion.trim() : '';
        if (raw === '9' || raw === '10') return raw as '9' | '10';
        return deriveTomcatVersionForDhis2(str(b.version));
      })(),
      resources: { cpu, memory, storage },
      dbStrategy,
      database: {
        host: dbHost,
        port: dbPort,
        name: dbName,
        user: dbUser,
        password: dbPassword,
      },
      databaseAdmin: {
        user: str(adminIn.user),
        password:
          typeof adminIn.password === 'string' && adminIn.password !== ''
            ? adminIn.password
            : undefined,
      },
      pauseSource:
        typeof b.pauseSource === 'boolean' ? b.pauseSource : undefined,
      shutdownTimeout: num(b.shutdownTimeout),
      restartTomcat:
        typeof b.restartTomcat === 'boolean' ? b.restartTomcat : undefined,
      proxy: {
        host: str(proxyIn.host),
        sshPort: num(proxyIn.sshPort),
        sshUser: str(proxyIn.sshUser),
        sshKeyPath: str(proxyIn.sshKeyPath),
        nginxConfigPath: str(proxyIn.nginxConfigPath),
        nginxReloadCommand: str(proxyIn.nginxReloadCommand),
      },
      skipCertbot:
        typeof b.skipCertbot === 'boolean' ? b.skipCertbot : undefined,
      email: str(b.email),
      proxmox: {
        apiUrl: str(proxmoxIn.apiUrl),
        apiUser: str(proxmoxIn.apiUser),
        apiTokenId: str(proxmoxIn.apiTokenId),
        apiTokenSecret:
          typeof proxmoxIn.apiTokenSecret === 'string'
            ? proxmoxIn.apiTokenSecret
            : undefined,
        validateApiCerts:
          typeof proxmoxIn.validateApiCerts === 'boolean'
            ? proxmoxIn.validateApiCerts
            : undefined,
      },
    };
  }

  router.post('/instances/:id/clone', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml.',
      });
      return;
    }
    const sourceId = req.params.id;
    const persisted = await provisionService.listInstances();
    const source = persisted.find(i => i.id === sourceId);
    if (!source) {
      res.status(404).json({ error: `Source instance ${sourceId} not found` });
      return;
    }
    let payload: CloneRequest;
    try {
      payload = parseCloneRequest(sourceId, req.body, {
        vmid: source.vmid,
        node: source.node,
        hostname: source.name,
        domain: source.domain,
        database: {
          host: source.database.host,
          port: source.database.port,
          name: source.database.name,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    // Avoid collisions with already-registered instances.
    if (persisted.some(i => i.id === `dhis2-${payload.vmid}`)) {
      res.status(409).json({
        error: `An instance with vmid=${payload.vmid} is already registered`,
      });
      return;
    }
    let job;
    try {
      job = provisionService.startCloneJob(payload);
    } catch (err) {
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    logger.info(
      `DHIS2: clone job ${job.id} started: src=${payload.source.vmid}@${payload.source.node} -> ${payload.name} (vmid=${payload.vmid}, node=${payload.node}, db_strategy=${payload.dbStrategy})`,
    );
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  // ---------------------------------------------------------------------
  // Upgrade DHIS2 WAR on an existing instance (in-place WAR swap + restart)
  // ---------------------------------------------------------------------
  function parseUpgradeRequest(
    instanceId: string,
    body: unknown,
    source: {
      vmid: string;
      node: string;
      hostname: string;
      domain: string;
      database: {
        host?: string;
        port?: number;
        name: string;
        user: string;
        password?: string;
      };
    },
  ): UpgradeRequest {
    const b = (body && typeof body === 'object' ? body : {}) as Record<
      string,
      any
    >;
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

    const vmid = Number(source.vmid);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      throw new InputError(`Instance has invalid vmid "${source.vmid}"`);
    }

    const toVersion = str(b.toVersion);
    if (!toVersion) {
      throw new InputError(
        'toVersion is required (e.g. "2.41.3" or "41.2.0")',
      );
    }
    // Sanity-check the version label so the playbook's URL derivation
    // produces something useful. Accept "2.41.3", "41.2.0", "41.2", "41".
    if (!/^[0-9]+(?:\.[0-9]+){0,3}$/.test(toVersion)) {
      throw new InputError(
        `toVersion "${toVersion}" does not look like a DHIS2 version label`,
      );
    }

    const backupRetainNum = num(b.backupRetain);
    if (
      backupRetainNum !== undefined &&
      (!Number.isInteger(backupRetainNum) || backupRetainNum <= 0)
    ) {
      throw new InputError('backupRetain must be a positive integer');
    }

    const dbIn =
      b.database && typeof b.database === 'object'
        ? (b.database as Record<string, any>)
        : {};
    const dbHost = str(dbIn.host) ?? source.database.host;
    const dbPort = num(dbIn.port) ?? source.database.port ?? 5432;
    const dbName = str(dbIn.name) ?? source.database.name;
    const dbUser = str(dbIn.user) ?? source.database.user;
    const dbPassword =
      typeof dbIn.password === 'string' && dbIn.password !== ''
        ? dbIn.password
        : source.database.password;

    const proxyIn =
      b.proxy && typeof b.proxy === 'object'
        ? (b.proxy as Record<string, any>)
        : {};
    const proxmoxIn =
      b.proxmox && typeof b.proxmox === 'object'
        ? (b.proxmox as Record<string, any>)
        : {};

    return {
      instanceId,
      vmid,
      node: source.node,
      hostname: source.hostname,
      name: str(b.name) ?? source.hostname,
      domain: source.domain,
      toVersion,
      tomcatVersion: (() => {
        const raw =
          typeof b.tomcatVersion === 'string' ? b.tomcatVersion.trim() : '';
        if (raw === '9' || raw === '10') return raw as '9' | '10';
        return deriveTomcatVersionForDhis2(toVersion);
      })(),
      warUrl: str(b.warUrl),
      warFile: str(b.warFile),
      backupDb:
        typeof b.backupDb === 'boolean' ? b.backupDb : undefined,
      backupRetain: backupRetainNum,
      tomcatService: str(b.tomcatService),
      webappsDir: str(b.webappsDir),
      database: {
        host: dbHost,
        port: dbPort,
        name: dbName,
        user: dbUser,
        password: dbPassword,
      },
      proxy: {
        host: str(proxyIn.host),
        sshPort: num(proxyIn.sshPort),
        sshUser: str(proxyIn.sshUser),
        sshKeyPath: str(proxyIn.sshKeyPath),
      },
      proxmox: {
        apiUrl: str(proxmoxIn.apiUrl),
        apiUser: str(proxmoxIn.apiUser),
        apiTokenId: str(proxmoxIn.apiTokenId),
        apiTokenSecret:
          typeof proxmoxIn.apiTokenSecret === 'string'
            ? proxmoxIn.apiTokenSecret
            : undefined,
        validateApiCerts:
          typeof proxmoxIn.validateApiCerts === 'boolean'
            ? proxmoxIn.validateApiCerts
            : undefined,
      },
    };
  }

  router.post('/instances/:id/upgrade', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({
        error:
          'Provisioning orchestrator is not configured. Set dhis2.orchestrator in app-config.yaml.',
      });
      return;
    }
    const instanceId = req.params.id;
    const persisted = await provisionService.listInstances();
    const source = persisted.find(i => i.id === instanceId);
    if (!source) {
      res.status(404).json({ error: `Instance ${instanceId} not found` });
      return;
    }
    let payload: UpgradeRequest;
    try {
      payload = parseUpgradeRequest(instanceId, req.body, {
        vmid: source.vmid,
        node: source.node,
        hostname: source.name,
        domain: source.domain,
        database: {
          host: source.database.host,
          port: source.database.port,
          name: source.database.name,
          user: source.database.user,
          password: source.database.password,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    if (
      payload.backupDb !== false &&
      (!payload.database?.password || payload.database.password === '')
    ) {
      res.status(400).json({
        error:
          'database.password is required for a pre-upgrade pg_dump. Provide it in the request body or set backupDb=false.',
      });
      return;
    }
    const job = provisionService.startUpgradeJob(payload);
    logger.info(
      `DHIS2: upgrade job ${job.id} started: ${instanceId} (vmid=${payload.vmid}, node=${payload.node}) -> ${payload.toVersion}`,
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

  router.post('/instances/:id/logs', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    const sourceRaw = typeof b.source === 'string' ? b.source.trim() : '';
    const source: 'dhis2' | 'catalina' | 'auto' =
      sourceRaw === 'dhis2' || sourceRaw === 'catalina'
        ? sourceRaw
        : 'auto';
    let lines = 200;
    if (typeof b.lines === 'number' && Number.isFinite(b.lines)) {
      lines = b.lines;
    } else if (typeof b.lines === 'string' && b.lines.trim()) {
      const parsed = Number.parseInt(b.lines.trim(), 10);
      if (Number.isFinite(parsed)) lines = parsed;
    }
    // Optional per-request PVE SSH overrides. The frontend may pass an
    // explicit `pve` block when the operator has configured one in the
    // Proxmox panel; otherwise we fall back to the orchestrator config.
    const pveRaw =
      b.pve && typeof b.pve === 'object'
        ? (b.pve as Record<string, unknown>)
        : {};
    const str = (v: unknown) =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
    try {
      const result = await provisionService.tailInstanceLogs(req.params.id, {
        source,
        lines,
        pveHost: str(pveRaw.host),
        pveSshPort: num(pveRaw.sshPort),
        pveSshUser: str(pveRaw.sshUser),
        pveSshKeyPath: str(pveRaw.sshKeyPath),
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: tail logs failed: ${message}`);
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

  // Tail nginx access/error log for a single site (per-instance).
  router.post('/instances/:id/proxy-logs/tail', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    const kind = b.kind === 'error' ? 'error' : 'access';
    const lines =
      typeof b.lines === 'number' && Number.isFinite(b.lines)
        ? (b.lines as number)
        : undefined;
    try {
      const result = await provisionService.tailProxyLogs(
        req.params.id,
        parseProxyAccessOverrides(req.body),
        { kind, lines },
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: proxy-logs tail failed: ${message}`);
      res.status(400).json({ error: message });
    }
  });

  // Tail the global nginx access/error log (not scoped to a site).
  router.post('/proxy-logs/tail', async (req, res) => {
    if (!provisionService.isConfigured()) {
      res.status(503).json({ error: 'DHIS2 orchestrator is not configured.' });
      return;
    }
    const b =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
    const kind = b.kind === 'error' ? 'error' : 'access';
    const lines =
      typeof b.lines === 'number' && Number.isFinite(b.lines)
        ? (b.lines as number)
        : undefined;
    try {
      const result = await provisionService.tailProxyLogs(
        undefined,
        parseProxyAccessOverrides(req.body),
        { kind, lines },
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DHIS2: proxy-logs tail (global) failed: ${message}`);
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
