import { DatabaseService } from '@backstage/backend-plugin-api';

const TABLE = 'ipam_sync_runs';
const KEEP = 200;

/** One run of ipam_sync.py as reported by the sync itself */
export interface SyncRun {
  finishedAt: string;
  durationSeconds: number;
  sources: Record<string, number>; // observations per source
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
}

export interface SyncStatusStore {
  record(run: SyncRun): Promise<void>;
  latest(limit: number): Promise<SyncRun[]>;
}

export async function createSyncStatusStore(
  database: DatabaseService,
): Promise<SyncStatusStore> {
  const knex = await database.getClient();
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, t => {
      t.increments('id');
      t.timestamp('finished_at').notNullable();
      t.text('run').notNullable(); // JSON
    });
  }
  return {
    async record(run) {
      await knex(TABLE).insert({
        finished_at: new Date(run.finishedAt),
        run: JSON.stringify(run),
      });
      const old = await knex(TABLE)
        .select('id')
        .orderBy('id', 'desc')
        .offset(KEEP);
      if (old.length)
        await knex(TABLE)
          .whereIn(
            'id',
            old.map((r: any) => r.id),
          )
          .delete();
    },
    async latest(limit) {
      const rows = await knex(TABLE)
        .select('run')
        .orderBy('id', 'desc')
        .limit(limit);
      return rows.map((r: any) => JSON.parse(r.run));
    },
  };
}

/** Validate and normalise a report posted by the sync */
export function parseSyncRun(body: any): SyncRun {
  const num = (v: unknown) =>
    Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0;
  const finished = new Date(String(body?.finishedAt ?? ''));
  if (Number.isNaN(finished.getTime()))
    throw new Error('finishedAt must be an ISO timestamp');
  const sources: Record<string, number> = {};
  for (const [k, v] of Object.entries(body?.sources ?? {})) {
    if (/^[a-z]{1,20}$/.test(k)) sources[k] = num(v);
  }
  return {
    finishedAt: finished.toISOString(),
    durationSeconds: num(body?.durationSeconds),
    sources,
    created: num(body?.created),
    updated: num(body?.updated),
    skipped: num(body?.skipped),
    errors: (Array.isArray(body?.errors) ? body.errors : [])
      .slice(0, 20)
      .map((e: unknown) => String(e).slice(0, 500)),
    dryRun: Boolean(body?.dryRun),
  };
}
