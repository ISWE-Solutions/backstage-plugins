import { LoggerService } from '@backstage/backend-plugin-api';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { ProvisionService, PersistedInstance } from './provisionService';

export type TransferStatus = 'queued' | 'running' | 'success' | 'failed';

export interface DbEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface TransferOptions {
  /** Create the target database (CREATE DATABASE) before restoring. */
  createTargetDatabase?: boolean;
  /** Drop the target database first (DROP DATABASE IF EXISTS). */
  dropTargetIfExists?: boolean;
  /** Pass --no-owner to pg_dump (strip ownership statements). */
  noOwner?: boolean;
  /** Pass --no-privileges to pg_dump (strip ACL/GRANT statements). */
  noPrivileges?: boolean;
  /** Pass --clean --if-exists to pg_dump (drop existing objects). */
  clean?: boolean;
  /** Maintenance database used to create/drop the target db. Defaults to "postgres". */
  maintenanceDatabase?: string;
}

export interface TransferRequest {
  instanceId: string;
  source: DbEndpoint;
  target: DbEndpoint;
  options?: TransferOptions;
}

export interface TransferSnapshot {
  id: string;
  instanceId: string;
  status: TransferStatus;
  exitCode?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  lines: string[];
  /** Echo of source/target (NO passwords) for UI display. */
  request: {
    source: Omit<DbEndpoint, 'password'>;
    target: Omit<DbEndpoint, 'password'>;
    options: Required<
      Pick<
        TransferOptions,
        'createTargetDatabase'
        | 'dropTargetIfExists'
        | 'noOwner'
        | 'noPrivileges'
        | 'clean'
      >
    > & { maintenanceDatabase: string };
  };
}

const MAX_LOG_LINES = 5000;
const jobs = new Map<string, TransferSnapshot>();

function snapshot(job: TransferSnapshot): TransferSnapshot {
  return { ...job, lines: job.lines.slice() };
}

function appendLine(job: TransferSnapshot, line: string) {
  const trimmed = line.replace(/\r?\n$/, '');
  if (!trimmed) return;
  job.lines.push(trimmed);
  if (job.lines.length > MAX_LOG_LINES) {
    job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
  }
}

function streamLines(
  job: TransferSnapshot,
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteIdent(name: string): string {
  // PostgreSQL identifier double-quoting.
  return `"${name.replace(/"/g, '""')}"`;
}

function validIdentifier(name: string): boolean {
  // Postgres allows up to 63 chars; we accept a permissive printable subset
  // but disallow embedded double quotes (defense in depth).
  return name.length > 0 && name.length <= 63 && !/[\u0000-\u001f"]/.test(name);
}

function validateEndpoint(label: string, ep: DbEndpoint): void {
  if (!ep.host || typeof ep.host !== 'string') {
    throw new Error(`${label}.host is required`);
  }
  if (!Number.isInteger(ep.port) || ep.port <= 0 || ep.port > 65535) {
    throw new Error(`${label}.port must be an integer between 1 and 65535`);
  }
  if (!ep.user || typeof ep.user !== 'string') {
    throw new Error(`${label}.user is required`);
  }
  if (typeof ep.password !== 'string' || ep.password === '') {
    throw new Error(`${label}.password is required`);
  }
  if (!ep.database || !validIdentifier(ep.database)) {
    throw new Error(`${label}.database is required and must be a valid identifier`);
  }
}

async function runShell(
  job: TransferSnapshot,
  command: string,
  label: string,
): Promise<number> {
  appendLine(job, `▶ ${label}`);
  return await new Promise<number>(resolve => {
    const child = spawn('bash', ['-lc', command], { stdio: 'pipe' });
    streamLines(job, child.stdout, '');
    streamLines(job, child.stderr, '[stderr] ');
    child.on('error', err => {
      appendLine(job, `[error] ${err.message}`);
      resolve(-1);
    });
    child.on('close', code => resolve(typeof code === 'number' ? code : -1));
  });
}

export class DatabaseTransferService {
  constructor(
    private readonly logger: LoggerService,
    private readonly provisionService: ProvisionService,
  ) {}

  getJob(id: string): TransferSnapshot | null {
    const j = jobs.get(id);
    return j ? snapshot(j) : null;
  }

  async startJob(req: TransferRequest): Promise<TransferSnapshot> {
    validateEndpoint('source', req.source);
    validateEndpoint('target', req.target);

    // Confirm the referenced instance exists. Use the throwing variant so a
    // transient DB read failure propagates as an error and rejects this
    // request, instead of being conflated with "no instances persisted"
    // and silently skipping validation (fail-open).
    let instances: PersistedInstance[];
    try {
      instances = await this.provisionService.listInstancesOrThrow();
    } catch (err) {
      throw new Error(
        `Failed to validate instance ${req.instanceId}: could not read the instance list (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    if (instances.length > 0 && !instances.some(i => i.id === req.instanceId)) {
      // Soft check: only fail when we have a persisted list to compare
      // against. If listInstances returned empty (no state file configured)
      // we trust the caller.
      throw new Error(`Instance ${req.instanceId} not found`);
    }

    const opts: TransferSnapshot['request']['options'] = {
      createTargetDatabase: req.options?.createTargetDatabase ?? true,
      dropTargetIfExists: req.options?.dropTargetIfExists ?? false,
      noOwner: req.options?.noOwner ?? true,
      noPrivileges: req.options?.noPrivileges ?? true,
      clean: req.options?.clean ?? false,
      maintenanceDatabase:
        req.options?.maintenanceDatabase &&
        validIdentifier(req.options.maintenanceDatabase)
          ? req.options.maintenanceDatabase
          : 'postgres',
    };

    const id = randomUUID();
    const job: TransferSnapshot = {
      id,
      instanceId: req.instanceId,
      status: 'queued',
      startedAt: new Date().toISOString(),
      lines: [],
      request: {
        source: {
          host: req.source.host,
          port: req.source.port,
          user: req.source.user,
          database: req.source.database,
        },
        target: {
          host: req.target.host,
          port: req.target.port,
          user: req.target.user,
          database: req.target.database,
        },
        options: opts,
      },
    };
    jobs.set(id, job);

    // Fire-and-forget the transfer; the caller polls getJob().
    this.runTransfer(job, req, opts).catch(err => {
      this.logger.error(
        `DHIS2: transfer job ${job.id} crashed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      job.status = 'failed';
      job.error =
        err instanceof Error ? err.message : 'Transfer crashed unexpectedly';
      job.finishedAt = new Date().toISOString();
    });

    return snapshot(job);
  }

  private async runTransfer(
    job: TransferSnapshot,
    req: TransferRequest,
    opts: TransferSnapshot['request']['options'],
  ): Promise<void> {
    job.status = 'running';
    appendLine(
      job,
      `Starting database transfer ${req.source.user}@${req.source.host}:${req.source.port}/${req.source.database} → ${req.target.user}@${req.target.host}:${req.target.port}/${req.target.database}`,
    );

    // Pre-flight: verify pg_dump and psql are on PATH.
    const preflight = await runShell(
      job,
      `command -v pg_dump >/dev/null && command -v psql >/dev/null`,
      'Checking for pg_dump and psql on backend host',
    );
    if (preflight !== 0) {
      job.status = 'failed';
      job.exitCode = preflight;
      job.error =
        'pg_dump or psql is not installed on the Backstage backend host. Install the postgresql-client package (e.g. apt-get install postgresql-client) and retry.';
      appendLine(job, `[error] ${job.error}`);
      job.finishedAt = new Date().toISOString();
      return;
    }

    const srcEnv = `PGPASSWORD=${shellQuote(req.source.password)}`;
    const tgtEnv = `PGPASSWORD=${shellQuote(req.target.password)}`;

    const tgtBaseConn =
      `-h ${shellQuote(req.target.host)} -p ${String(req.target.port)} ` +
      `-U ${shellQuote(req.target.user)} -v ON_ERROR_STOP=1`;

    if (opts.dropTargetIfExists) {
      const dropSql = `DROP DATABASE IF EXISTS ${quoteIdent(req.target.database)};`;
      const code = await runShell(
        job,
        `${tgtEnv} psql ${tgtBaseConn} -d ${shellQuote(opts.maintenanceDatabase)} -c ${shellQuote(dropSql)}`,
        `DROP DATABASE IF EXISTS ${req.target.database}`,
      );
      if (code !== 0) {
        job.status = 'failed';
        job.exitCode = code;
        job.error = `Failed to drop target database "${req.target.database}" (exit ${code}).`;
        appendLine(job, `[error] ${job.error}`);
        job.finishedAt = new Date().toISOString();
        return;
      }
    }

    if (opts.createTargetDatabase) {
      // Attempt CREATE DATABASE on the maintenance db, tolerating
      // "database already exists" so this step is idempotent. Then
      // verify connectivity to the target db itself before piping the
      // dump into it.
      const createSql = `CREATE DATABASE ${quoteIdent(req.target.database)};`;
      const createStep =
        `${tgtEnv} psql ${tgtBaseConn} -d ${shellQuote(opts.maintenanceDatabase)} ` +
        `-c ${shellQuote(createSql)} 2>&1 | grep -v 'already exists' || true`;
      const verifyStep =
        `${tgtEnv} psql -h ${shellQuote(req.target.host)} -p ${String(req.target.port)} ` +
        `-U ${shellQuote(req.target.user)} -d ${shellQuote(req.target.database)} -tAc 'SELECT 1'`;
      const code = await runShell(
        job,
        `${createStep}; ${verifyStep}`,
        `CREATE DATABASE ${req.target.database} (if missing)`,
      );
      if (code !== 0) {
        job.status = 'failed';
        job.exitCode = code;
        job.error = `Failed to create or reach target database "${req.target.database}" (exit ${code}).`;
        appendLine(job, `[error] ${job.error}`);
        job.finishedAt = new Date().toISOString();
        return;
      }
    }

    // Build pg_dump | psql pipeline.
    const dumpFlags = [
      '--no-password',
      opts.noOwner ? '--no-owner' : '',
      opts.noPrivileges ? '--no-privileges' : '',
      opts.clean ? '--clean' : '',
      opts.clean ? '--if-exists' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const pgDumpCmd =
      `${srcEnv} pg_dump ${dumpFlags} ` +
      `-h ${shellQuote(req.source.host)} -p ${String(req.source.port)} ` +
      `-U ${shellQuote(req.source.user)} -d ${shellQuote(req.source.database)}`;

    const psqlCmd =
      `${tgtEnv} psql ${tgtBaseConn} -d ${shellQuote(req.target.database)}`;

    // pipefail makes the pipeline fail if pg_dump errors out, even if psql
    // exits 0. Wrap the inner command in single quotes for `bash -lc`.
    const pipeline = `set -o pipefail; ${pgDumpCmd} | ${psqlCmd}`;

    const code = await runShell(
      job,
      pipeline,
      `pg_dump → psql (${req.source.database} → ${req.target.database})`,
    );

    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      job.status = 'success';
      appendLine(job, '✓ Transfer completed successfully.');
      this.logger.info(
        `DHIS2: transfer job ${job.id} succeeded (${req.source.database} → ${req.target.host}/${req.target.database})`,
      );
    } else {
      job.status = 'failed';
      job.error = `pg_dump | psql exited with code ${code}.`;
      this.logger.warn(
        `DHIS2: transfer job ${job.id} failed (exit=${code}, ${req.source.database} → ${req.target.host}/${req.target.database})`,
      );
    }
  }
}
