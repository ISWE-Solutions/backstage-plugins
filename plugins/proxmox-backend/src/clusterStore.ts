import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@backstage/backend-plugin-api';

const TABLE = 'proxmox_clusters';

/** A cluster stored in the database, including its API token (server-side only). */
export interface DbCluster {
  id: string;
  name: string;
  url: string;
  token: string;
  verifyTls: boolean;
  uiUrls: Record<string, string>;
}

export interface ClusterInput {
  name: string;
  url: string;
  /** Omit on update to keep the existing token */
  token?: string;
  verifyTls?: boolean;
  uiUrls?: Record<string, string>;
}

export interface ClusterStore {
  list(): Promise<DbCluster[]>;
  get(id: string): Promise<DbCluster | undefined>;
  add(input: ClusterInput): Promise<DbCluster>;
  update(id: string, patch: ClusterInput): Promise<DbCluster | undefined>;
  remove(id: string): Promise<boolean>;
}

const rowToCluster = (r: any): DbCluster => ({
  id: String(r.id),
  name: String(r.name),
  url: String(r.url),
  token: String(r.token),
  verifyTls: Boolean(r.verify_tls),
  uiUrls: r.ui_urls ? JSON.parse(r.ui_urls) : {},
});

/**
 * Persists UI-added Proxmox clusters. Tokens are stored server-side and never
 * leave the backend (the router only ever returns cluster metadata, not tokens).
 */
export async function createClusterStore(
  database: DatabaseService,
): Promise<ClusterStore> {
  const knex = await database.getClient();
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, t => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('url').notNullable();
      t.text('token').notNullable();
      t.boolean('verify_tls').notNullable().defaultTo(false);
      t.text('ui_urls'); // JSON
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }

  return {
    async list() {
      const rows = await knex(TABLE).select('*').orderBy('name');
      return rows.map(rowToCluster);
    },
    async get(id) {
      const r = await knex(TABLE).where({ id }).first();
      return r ? rowToCluster(r) : undefined;
    },
    async add(input) {
      const row = {
        id: randomUUID(),
        name: input.name,
        url: input.url,
        token: input.token ?? '',
        verify_tls: input.verifyTls ?? false,
        ui_urls: JSON.stringify(input.uiUrls ?? {}),
      };
      await knex(TABLE).insert(row);
      return rowToCluster(row);
    },
    async update(id, patch) {
      const existing = await knex(TABLE).where({ id }).first();
      if (!existing) return undefined;
      const row: Record<string, unknown> = {
        name: patch.name,
        url: patch.url,
        verify_tls: patch.verifyTls ?? false,
        ui_urls: JSON.stringify(patch.uiUrls ?? {}),
      };
      // keep the stored token when the caller does not supply a new one
      if (patch.token) row.token = patch.token;
      await knex(TABLE).where({ id }).update(row);
      const updated = await knex(TABLE).where({ id }).first();
      return rowToCluster(updated);
    },
    async remove(id) {
      const n = await knex(TABLE).where({ id }).delete();
      return n > 0;
    },
  };
}
