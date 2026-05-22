import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import type { PersistedInstance } from './provisionService';

type KnexClient = Awaited<ReturnType<DatabaseService['getClient']>>;

interface InstanceRow {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: PersistedInstance['status'];
  version: string;
  url: string;
  domain: string;
  database_json: string;
  resources_json: string;
  tomcat_version?: string | null;
  proxy_override_json?: string | null;
  restore_json?: string | null;
  proxy_settings_json?: string | null;
  dhis2_settings_json?: string | null;
  created_at: string;
  updated_at: string;
}

const TABLE = 'dhis2_instances';

function toRow(i: PersistedInstance): InstanceRow {
  return {
    id: i.id,
    name: i.name,
    vmid: i.vmid,
    node: i.node,
    status: i.status,
    version: i.version,
    url: i.url,
    domain: i.domain,
    database_json: JSON.stringify(i.database ?? {}),
    resources_json: JSON.stringify(i.resources ?? {}),
    tomcat_version: i.tomcatVersion ?? null,
    proxy_override_json: i.proxyOverride
      ? JSON.stringify(i.proxyOverride)
      : null,
    restore_json: i.restore ? JSON.stringify(i.restore) : null,
    proxy_settings_json: i.proxySettings
      ? JSON.stringify(i.proxySettings)
      : null,
    dhis2_settings_json: i.dhis2Settings
      ? JSON.stringify(i.dhis2Settings)
      : null,
    created_at: i.created,
    updated_at: i.updated,
  };
}

function parseJsonOrUndefined<T>(value?: string | null): T | undefined {
  if (!value || value.trim() === '') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toModel(r: InstanceRow): PersistedInstance {
  const db = (() => {
    try {
      return JSON.parse(r.database_json ?? '{}') as PersistedInstance['database'];
    } catch {
      return { name: '', user: '' };
    }
  })();
  const resources = (() => {
    try {
      return JSON.parse(r.resources_json ?? '{}') as PersistedInstance['resources'];
    } catch {
      return { cpu: 1, memory: 512, storage: 5 };
    }
  })();
  return {
    id: r.id,
    name: r.name,
    vmid: r.vmid,
    node: r.node,
    status: r.status,
    version: r.version,
    url: r.url,
    domain: r.domain,
    database: db,
    resources,
    tomcatVersion: r.tomcat_version ?? undefined,
    proxyOverride: parseJsonOrUndefined<PersistedInstance['proxyOverride']>(
      r.proxy_override_json,
    ),
    restore: parseJsonOrUndefined<PersistedInstance['restore']>(r.restore_json),
    proxySettings: parseJsonOrUndefined<PersistedInstance['proxySettings']>(
      r.proxy_settings_json,
    ),
    dhis2Settings: parseJsonOrUndefined<PersistedInstance['dhis2Settings']>(
      r.dhis2_settings_json,
    ),
    created: r.created_at,
    updated: r.updated_at,
  };
}

export class InstanceStore {
  constructor(
    private readonly db: KnexClient,
    private readonly logger: LoggerService,
  ) {}

  async init(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE);
    if (!exists) {
      await this.db.schema.createTable(TABLE, table => {
        table.string('id').primary();
        table.string('name').notNullable();
        table.string('vmid').notNullable();
        table.string('node').notNullable();
        table.string('status').notNullable();
        table.string('version').notNullable();
        table.string('url').notNullable();
        table.string('domain').notNullable();
        table.text('database_json').notNullable();
        table.text('resources_json').notNullable();
        table.string('tomcat_version').nullable();
        table.text('proxy_override_json').nullable();
        table.text('restore_json').nullable();
        table.text('proxy_settings_json').nullable();
        table.text('dhis2_settings_json').nullable();
        table.string('created_at').notNullable();
        table.string('updated_at').notNullable();
        table.index(['node', 'vmid'], 'dhis2_instances_node_vmid_idx');
      });
      this.logger.info('DHIS2: initialized table dhis2_instances');
      return;
    }

    // Backward-compatible column migration for older deployments.
    const ensureColumn = async (
      name: string,
      alter: (table: any) => void,
    ): Promise<void> => {
      const has = await this.db.schema.hasColumn(TABLE, name);
      if (has) return;
      await this.db.schema.alterTable(TABLE, table => {
        alter(table);
      });
      this.logger.info(`DHIS2: added column ${TABLE}.${name}`);
    };

    await ensureColumn('tomcat_version', table => table.string('tomcat_version').nullable());
    await ensureColumn('proxy_override_json', table => table.text('proxy_override_json').nullable());
    await ensureColumn('restore_json', table => table.text('restore_json').nullable());
    await ensureColumn('proxy_settings_json', table => table.text('proxy_settings_json').nullable());
    await ensureColumn('dhis2_settings_json', table => table.text('dhis2_settings_json').nullable());
  }

  async list(): Promise<PersistedInstance[]> {
    const rows = (await this.db<InstanceRow>(TABLE)
      .select('*')
      .orderBy('created_at', 'asc')) as InstanceRow[];
    return rows.map(toModel);
  }

  async getById(id: string): Promise<PersistedInstance | null> {
    const row = (await this.db<InstanceRow>(TABLE)
      .where({ id })
      .first()) as InstanceRow | undefined;
    return row ? toModel(row) : null;
  }

  async upsert(instance: PersistedInstance): Promise<void> {
    const row = toRow(instance);
    const exists = await this.db<InstanceRow>(TABLE)
      .where({ id: row.id })
      .first();
    if (exists) {
      await this.db<InstanceRow>(TABLE).where({ id: row.id }).update(row);
      return;
    }
    await this.db<InstanceRow>(TABLE).insert(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const deleted = await this.db<InstanceRow>(TABLE).where({ id }).delete();
    return deleted > 0;
  }

  async updateById(
    id: string,
    patch: Partial<PersistedInstance>,
  ): Promise<PersistedInstance | null> {
    const current = await this.getById(id);
    if (!current) return null;
    const merged: PersistedInstance = {
      ...current,
      ...patch,
      database: { ...current.database, ...(patch.database ?? {}) },
      resources: { ...current.resources, ...(patch.resources ?? {}) },
      updated: new Date().toISOString(),
    };
    await this.upsert(merged);
    return merged;
  }
}
