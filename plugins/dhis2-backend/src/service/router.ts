import { LoggerService, HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { Client } from 'pg';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
}

interface DbCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

const CONNECTION_TIMEOUT_MS = 5_000;

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
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: CONNECTION_TIMEOUT_MS,
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

function describeError(err: unknown): { message: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    const message =
      typeof e.message === 'string' && e.message !== ''
        ? e.message
        : 'Failed to connect to PostgreSQL';
    const code = typeof e.code === 'string' ? e.code : undefined;
    return { message, code };
  }
  return { message: 'Failed to connect to PostgreSQL' };
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth } = options;

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
      const { message, code } = describeError(err);
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
      const { message, code } = describeError(err);
      logger.warn(
        `DHIS2: listDatabases FAILED on ${creds.host}:${creds.port} as ${creds.user}: ${message}${code ? ` [${code}]` : ''}`,
      );
      res.status(502).json({ error: message, code });
    }
  });

  return router;
}
