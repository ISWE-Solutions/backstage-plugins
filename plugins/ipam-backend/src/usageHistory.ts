import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { Raw } from '@internal/plugin-ipam-common';
import { PhpIpamClient } from './phpipamClient';

const TABLE = 'ipam_subnet_usage';

export interface UsagePoint {
  date: string; // YYYY-MM-DD
  subnetId: string;
  cidr: string;
  used: number;
  max: number;
}

export interface UsageHistory {
  /** Record today's usage of every subnet (once per day; later runs overwrite) */
  snapshot(): Promise<number>;
  list(days: number): Promise<UsagePoint[]>;
}

/** Daily subnet-usage history in the ipam plugin's database */
export async function createUsageHistory(
  database: DatabaseService,
  phpipam: PhpIpamClient,
  logger: LoggerService,
): Promise<UsageHistory> {
  const knex = await database.getClient();
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, t => {
      t.string('date', 10).notNullable();
      t.string('subnet_id', 32).notNullable();
      t.string('cidr', 64).notNullable();
      t.integer('used').notNullable();
      t.integer('max').notNullable();
      t.primary(['date', 'subnet_id']);
    });
  }
  return {
    async snapshot() {
      const subnets =
        ((await phpipam.request('GET', 'subnets/')).body as any)?.data ?? [];
      const date = new Date().toISOString().slice(0, 10);
      let n = 0;
      for (const s of subnets as Raw[]) {
        if (
          String(s.isFolder) === '1' ||
          !s.subnet ||
          String(s.subnet).includes(':')
        )
          continue;
        const usage = (
          (await phpipam.request('GET', `subnets/${s.id}/usage/`)).body as any
        )?.data;
        await knex(TABLE)
          .insert({
            date,
            subnet_id: String(s.id),
            cidr: `${s.subnet}/${s.mask}`,
            used: Number(usage?.used ?? 0),
            max: Number(usage?.maxhosts ?? 0),
          })
          .onConflict(['date', 'subnet_id'])
          .merge();
        n++;
      }
      logger.info(`ipam: recorded usage of ${n} subnets for ${date}`);
      return n;
    },
    async list(days) {
      const since = new Date(Date.now() - days * 86400_000)
        .toISOString()
        .slice(0, 10);
      const rows = await knex(TABLE)
        .where('date', '>=', since)
        .orderBy(['date', 'cidr']);
      return rows.map((r: any) => ({
        date: r.date,
        subnetId: r.subnet_id,
        cidr: r.cidr,
        used: Number(r.used),
        max: Number(r.max),
      }));
    },
  };
}
