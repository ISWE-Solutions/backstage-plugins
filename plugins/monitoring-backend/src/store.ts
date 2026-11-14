import { DatabaseService } from '@backstage/backend-plugin-api';
import { SettingValue } from './settings';

const TABLE = 'monitoring_settings';

export interface StoredSetting {
  value: SettingValue;
  updatedBy: string;
  updatedAt: string;
}

export interface SettingsStore {
  all(): Promise<Record<string, StoredSetting>>;
  /** saves `{ key: value }`, removes `{ key: null }`, in one transaction */
  apply(
    changes: Record<string, SettingValue | null>,
    by: string,
  ): Promise<void>;
}

/** The shared settings, one row per setting (value as JSON), with who changed it and when. */
export async function createSettingsStore(
  database: DatabaseService,
): Promise<SettingsStore> {
  const knex = await database.getClient();
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, t => {
      t.string('key').primary();
      t.text('value').notNullable();
      t.string('updated_by').notNullable();
      t.timestamp('updated_at').notNullable();
    });
  }
  return {
    async all() {
      const rows = await knex(TABLE).select('*');
      return Object.fromEntries(
        rows.map((r: any) => [
          String(r.key),
          {
            value: JSON.parse(r.value),
            updatedBy: String(r.updated_by),
            updatedAt: new Date(r.updated_at).toISOString(),
          },
        ]),
      );
    },
    async apply(changes, by) {
      const now = new Date();
      await knex.transaction(async tx => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) {
            await tx(TABLE).where({ key }).delete();
          } else {
            await tx(TABLE)
              .insert({
                key,
                value: JSON.stringify(value),
                updated_by: by,
                updated_at: now,
              })
              .onConflict('key')
              .merge();
          }
        }
      });
    },
  };
}
