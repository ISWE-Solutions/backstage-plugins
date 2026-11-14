import knexFactory from 'knex';
import { DatabaseService } from '@backstage/backend-plugin-api';

/** An in-memory SQLite database, for tests. */
export function testDatabase(): DatabaseService {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  return { getClient: async () => knex } as unknown as DatabaseService;
}
