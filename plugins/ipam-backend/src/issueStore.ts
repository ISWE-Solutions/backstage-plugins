import { DatabaseService } from '@backstage/backend-plugin-api';
import { IssueStore, NotableIssue } from './notifier';

const TABLE = 'ipam_notified_issues';

/** Notified-issue keys kept in the ipam plugin's own database */
export async function createDatabaseIssueStore(
  database: DatabaseService,
): Promise<IssueStore> {
  const knex = await database.getClient();
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, table => {
      table.string('key', 255).primary();
      table.string('severity', 16).notNullable();
      table.text('text').notNullable();
      table.timestamp('notified_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  return {
    async keys() {
      return (await knex(TABLE).select('key')).map(
        (r: { key: string }) => r.key,
      );
    },
    async add(issues: NotableIssue[]) {
      if (!issues.length) return;
      await knex(TABLE)
        .insert(
          issues.map(i => ({ key: i.key, severity: i.severity, text: i.text })),
        )
        .onConflict('key')
        .ignore();
    },
    async remove(keys: string[]) {
      if (keys.length) await knex(TABLE).whereIn('key', keys).delete();
    },
  };
}
