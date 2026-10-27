import { DatabaseService } from '@backstage/backend-plugin-api';
import {
  BatchCommit,
  BatchSlot,
  BatchState,
  BuildLocalState,
  BuildParams,
  BuildResult,
  LogLevel,
  RunbotBatch,
  RunbotBranch,
  RunbotBuild,
  RunbotBuildLog,
  RunbotBuildSummary,
  RunbotBundle,
  RunbotHost,
  RunbotProject,
  RunbotRepo,
  RunbotTrigger,
  TriggerStep,
} from '@iswesolutions/plugin-odoo-runbot-common';

/** The Knex client Backstage's database service hands out */
type Knex = Awaited<ReturnType<DatabaseService['getClient']>>;
type TableBuilder = Parameters<Knex['schema']['createTable']>[1];

const T = {
  projects: 'runbot_projects',
  repos: 'runbot_repos',
  triggers: 'runbot_triggers',
  bundles: 'runbot_bundles',
  branches: 'runbot_branches',
  batches: 'runbot_batches',
  batchCommits: 'runbot_batch_commits',
  slots: 'runbot_batch_slots',
  builds: 'runbot_builds',
  logs: 'runbot_build_logs',
  hosts: 'runbot_hosts',
};

/** Lines kept per build; later lines are counted but not stored */
export const MAX_LOG_LINES = 50000;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <V>(v: unknown, fallback: V): V => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as V;
  } catch {
    return fallback;
  }
};
const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';

async function migrate(knex: Knex) {
  const create = async (name: string, build: TableBuilder) => {
    if (!(await knex.schema.hasTable(name)))
      await knex.schema.createTable(name, build);
  };
  await create(T.projects, t => {
    t.increments('id');
    t.string('name').notNullable().unique();
    t.text('base_branches').notNullable(); // JSON
    t.string('master_base').notNullable();
    t.integer('batch_delay').notNullable().defaultTo(60);
    t.string('created').notNullable();
  });
  await create(T.repos, t => {
    t.increments('id');
    t.integer('project_id').notNullable().index();
    t.string('name').notNullable();
    t.string('slug').notNullable();
    t.boolean('is_server').notNullable().defaultTo(false);
    t.string('addons_subdir').notNullable().defaultTo('');
    t.string('default_branch').notNullable().defaultTo('');
    t.string('entity_ref');
    t.boolean('active').notNullable().defaultTo(true);
    t.string('last_polled');
    t.text('poll_error');
    t.string('created').notNullable();
    t.unique(['project_id', 'slug']);
  });
  await create(T.triggers, t => {
    t.increments('id');
    t.integer('project_id').notNullable().index();
    t.string('name').notNullable();
    t.text('repo_ids').notNullable();
    t.text('dependency_repo_ids').notNullable();
    t.text('steps').notNullable();
    t.string('ci_context').notNullable();
    t.boolean('base_only').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('sequence').notNullable().defaultTo(10);
  });
  await create(T.bundles, t => {
    t.increments('id');
    t.integer('project_id').notNullable();
    t.string('name').notNullable();
    t.boolean('is_base').notNullable().defaultTo(false);
    t.string('base_name').notNullable();
    t.string('version').notNullable();
    t.boolean('sticky').notNullable().defaultTo(false);
    t.integer('last_batch_id');
    t.string('updated').notNullable();
    t.unique(['project_id', 'name']);
  });
  await create(T.branches, t => {
    t.increments('id');
    t.integer('repo_id').notNullable();
    // "#12" for pull request 12, else the branch name
    t.string('name').notNullable();
    t.string('head_sha').notNullable();
    t.integer('bundle_id').notNullable().index();
    t.boolean('is_pr').notNullable().defaultTo(false);
    t.integer('pr_number');
    t.string('pr_target');
    t.text('pr_title');
    t.string('pr_author');
    t.boolean('pr_draft');
    t.string('pr_head_slug');
    t.boolean('alive').notNullable().defaultTo(true);
    t.string('updated').notNullable();
    t.unique(['repo_id', 'name']);
  });
  await create(T.batches, t => {
    t.increments('id');
    t.integer('bundle_id').notNullable().index();
    t.string('state').notNullable();
    t.string('created').notNullable();
    t.string('ready_at');
  });
  await create(T.batchCommits, t => {
    t.integer('batch_id').notNullable().index();
    t.integer('repo_id').notNullable();
    t.string('sha').notNullable();
    t.string('match').notNullable();
  });
  await create(T.slots, t => {
    t.integer('batch_id').notNullable().index();
    t.integer('trigger_id').notNullable();
    t.integer('build_id').index();
    t.text('skip_reason');
  });
  await create(T.builds, t => {
    t.increments('id');
    t.integer('project_id').notNullable();
    t.integer('trigger_id').notNullable();
    t.string('params_hash').notNullable().index();
    t.text('params').notNullable();
    t.string('local_state').notNullable().index();
    t.string('result');
    t.string('host');
    t.string('requested').notNullable();
    t.string('started');
    t.string('finished');
    t.text('error_summary');
    t.boolean('kill_requested').notNullable().defaultTo(false);
    t.integer('log_count').notNullable().defaultTo(0);
  });
  await create(T.logs, t => {
    t.increments('id');
    t.integer('build_id').notNullable().index();
    t.string('level').notNullable();
    t.string('logger').notNullable();
    t.text('message').notNullable();
    t.string('created').notNullable();
  });
  await create(T.hosts, t => {
    t.string('name').primary();
    t.string('last_seen').notNullable();
    t.integer('workers').notNullable();
    t.text('running').notNullable();
    t.string('version').notNullable();
  });
}

const toProject = (r: any): RunbotProject => ({
  id: r.id,
  name: r.name,
  baseBranches: parse(r.base_branches, []),
  masterBase: r.master_base,
  batchDelay: r.batch_delay,
  created: r.created,
});
const toRepo = (r: any): RunbotRepo => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  slug: r.slug,
  isServer: bool(r.is_server),
  addonsSubdir: r.addons_subdir ?? '',
  defaultBranch: r.default_branch ?? '',
  entityRef: r.entity_ref ?? undefined,
  active: bool(r.active),
  lastPolled: r.last_polled ?? undefined,
  pollError: r.poll_error ?? undefined,
  created: r.created,
});
const toTrigger = (r: any): RunbotTrigger => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  repoIds: parse(r.repo_ids, []),
  dependencyRepoIds: parse(r.dependency_repo_ids, []),
  steps: parse<TriggerStep[]>(r.steps, []),
  ciContext: r.ci_context,
  baseOnly: bool(r.base_only),
  active: bool(r.active),
  sequence: r.sequence,
});
const toBranch = (r: any): RunbotBranch => ({
  id: r.id,
  repoId: r.repo_id,
  name: r.name,
  headSha: r.head_sha,
  bundleId: r.bundle_id,
  isPr: bool(r.is_pr),
  prNumber: r.pr_number ?? undefined,
  prTarget: r.pr_target ?? undefined,
  prTitle: r.pr_title ?? undefined,
  prAuthor: r.pr_author ?? undefined,
  prDraft:
    r.pr_draft === null || r.pr_draft === undefined
      ? undefined
      : bool(r.pr_draft),
  prHeadSlug: r.pr_head_slug ?? undefined,
  alive: bool(r.alive),
  updated: r.updated,
});
const toSummary = (r: any, triggerName: string): RunbotBuildSummary => ({
  id: r.id,
  triggerId: r.trigger_id,
  triggerName,
  localState: r.local_state as BuildLocalState,
  result: (r.result ?? undefined) as BuildResult | undefined,
  requested: r.requested,
  started: r.started ?? undefined,
  finished: r.finished ?? undefined,
  host: r.host ?? undefined,
  errorSummary: r.error_summary ?? undefined,
});

export interface BranchUpdate {
  repoId: number;
  name: string;
  headSha: string;
  bundleId: number;
  pr?: {
    number: number;
    target: string;
    title: string;
    author: string;
    draft: boolean;
    headSlug: string;
  };
}

export type RunbotStore = Awaited<ReturnType<typeof createRunbotStore>>;

export async function createRunbotStore(
  database: DatabaseService | { getClient(): Promise<Knex> },
) {
  const knex = await database.getClient();
  await migrate(knex);

  const triggerNames = async (ids: number[]) => {
    if (!ids.length) return new Map<number, string>();
    const rows = await knex(T.triggers)
      .whereIn('id', [...new Set(ids)])
      .select('id', 'name');
    return new Map<number, string>(rows.map((r: any) => [r.id, r.name]));
  };

  const store = {
    // --- projects
    async listProjects(): Promise<RunbotProject[]> {
      return (await knex(T.projects).orderBy('name')).map(toProject);
    },
    async getProject(id: number): Promise<RunbotProject | undefined> {
      const r = await knex(T.projects).where({ id }).first();
      return r ? toProject(r) : undefined;
    },
    async createProject(p: {
      name: string;
      baseBranches: string[];
      masterBase: string;
      batchDelay: number;
    }) {
      const [row] = await knex(T.projects)
        .insert({
          name: p.name,
          base_branches: json(p.baseBranches),
          master_base: p.masterBase,
          batch_delay: p.batchDelay,
          created: now(),
        })
        .returning('id');
      return (await store.getProject(typeof row === 'object' ? row.id : row))!;
    },
    async updateProject(
      id: number,
      p: Partial<{
        baseBranches: string[];
        masterBase: string;
        batchDelay: number;
      }>,
    ) {
      await knex(T.projects)
        .where({ id })
        .update({
          ...(p.baseBranches ? { base_branches: json(p.baseBranches) } : {}),
          ...(p.masterBase ? { master_base: p.masterBase } : {}),
          ...(p.batchDelay !== undefined ? { batch_delay: p.batchDelay } : {}),
        });
      return store.getProject(id);
    },

    // --- repos
    async listRepos(
      projectId?: number,
      activeOnly = false,
    ): Promise<RunbotRepo[]> {
      const q = knex(T.repos).orderBy([
        { column: 'is_server', order: 'desc' },
        'name',
      ]);
      if (projectId !== undefined) q.where({ project_id: projectId });
      if (activeOnly) q.where({ active: true });
      return (await q).map(toRepo);
    },
    async getRepo(id: number): Promise<RunbotRepo | undefined> {
      const r = await knex(T.repos).where({ id }).first();
      return r ? toRepo(r) : undefined;
    },
    async createRepo(
      r: Omit<
        RunbotRepo,
        'id' | 'created' | 'active' | 'lastPolled' | 'pollError'
      >,
    ) {
      const [row] = await knex(T.repos)
        .insert({
          project_id: r.projectId,
          name: r.name,
          slug: r.slug,
          is_server: r.isServer,
          addons_subdir: r.addonsSubdir,
          default_branch: r.defaultBranch,
          entity_ref: r.entityRef ?? null,
          active: true,
          created: now(),
        })
        .returning('id');
      return (await store.getRepo(typeof row === 'object' ? row.id : row))!;
    },
    async setRepoPolled(id: number, error?: string) {
      await knex(T.repos)
        .where({ id })
        .update({ last_polled: now(), poll_error: error ?? null });
    },
    async setRepoActive(id: number, active: boolean) {
      await knex(T.repos).where({ id }).update({ active });
    },

    // --- triggers
    async listTriggers(projectId?: number): Promise<RunbotTrigger[]> {
      const q = knex(T.triggers).orderBy(['sequence', 'id']);
      if (projectId !== undefined) q.where({ project_id: projectId });
      return (await q).map(toTrigger);
    },
    async createTrigger(t: Omit<RunbotTrigger, 'id'>) {
      const [row] = await knex(T.triggers)
        .insert({
          project_id: t.projectId,
          name: t.name,
          repo_ids: json(t.repoIds),
          dependency_repo_ids: json(t.dependencyRepoIds),
          steps: json(t.steps),
          ci_context: t.ciContext,
          base_only: t.baseOnly,
          active: t.active,
          sequence: t.sequence,
        })
        .returning('id');
      const id = typeof row === 'object' ? row.id : row;
      return toTrigger(await knex(T.triggers).where({ id }).first());
    },
    async updateTrigger(
      id: number,
      t: Partial<Omit<RunbotTrigger, 'id' | 'projectId'>>,
    ) {
      await knex(T.triggers)
        .where({ id })
        .update({
          ...(t.name !== undefined ? { name: t.name } : {}),
          ...(t.repoIds ? { repo_ids: json(t.repoIds) } : {}),
          ...(t.dependencyRepoIds
            ? { dependency_repo_ids: json(t.dependencyRepoIds) }
            : {}),
          ...(t.steps ? { steps: json(t.steps) } : {}),
          ...(t.ciContext !== undefined ? { ci_context: t.ciContext } : {}),
          ...(t.baseOnly !== undefined ? { base_only: t.baseOnly } : {}),
          ...(t.active !== undefined ? { active: t.active } : {}),
          ...(t.sequence !== undefined ? { sequence: t.sequence } : {}),
        });
      const r = await knex(T.triggers).where({ id }).first();
      return r ? toTrigger(r) : undefined;
    },

    // --- bundles and branches
    async getOrCreateBundle(b: {
      projectId: number;
      name: string;
      isBase: boolean;
      baseName: string;
      version: string;
    }) {
      const existing = await knex(T.bundles)
        .where({ project_id: b.projectId, name: b.name })
        .first();
      if (existing) {
        if (
          bool(existing.is_base) !== b.isBase ||
          existing.base_name !== b.baseName ||
          existing.version !== b.version
        ) {
          await knex(T.bundles).where({ id: existing.id }).update({
            is_base: b.isBase,
            sticky: b.isBase,
            base_name: b.baseName,
            version: b.version,
          });
        }
        return existing.id as number;
      }
      const [row] = await knex(T.bundles)
        .insert({
          project_id: b.projectId,
          name: b.name,
          is_base: b.isBase,
          base_name: b.baseName,
          version: b.version,
          sticky: b.isBase,
          updated: now(),
        })
        .returning('id');
      return (typeof row === 'object' ? row.id : row) as number;
    },
    async findBundle(projectId: number, name: string) {
      return knex(T.bundles).where({ project_id: projectId, name }).first();
    },

    /** Insert or update a branch; returns whether its head is new */
    async upsertBranch(u: BranchUpdate): Promise<boolean> {
      const existing = await knex(T.branches)
        .where({ repo_id: u.repoId, name: u.name })
        .first();
      const fields = {
        head_sha: u.headSha,
        bundle_id: u.bundleId,
        is_pr: Boolean(u.pr),
        pr_number: u.pr?.number ?? null,
        pr_target: u.pr?.target ?? null,
        pr_title: u.pr?.title ?? null,
        pr_author: u.pr?.author ?? null,
        pr_draft: u.pr ? u.pr.draft : null,
        pr_head_slug: u.pr?.headSlug ?? null,
        alive: true,
      };
      if (!existing) {
        await knex(T.branches).insert({
          repo_id: u.repoId,
          name: u.name,
          ...fields,
          updated: now(),
        });
        return true;
      }
      const changed = existing.head_sha !== u.headSha || !bool(existing.alive);
      await knex(T.branches)
        .where({ id: existing.id })
        .update({ ...fields, ...(changed ? { updated: now() } : {}) });
      return changed;
    },
    /** Branches of a repo that GitHub no longer lists */
    async markDeadBranches(repoId: number, aliveNames: string[]) {
      await knex(T.branches)
        .where({ repo_id: repoId, alive: true })
        .whereNotIn('name', aliveNames.length ? aliveNames : ['\u0000'])
        .update({ alive: false, updated: now() });
    },
    /** Head commit per repo of a bundle's live branches (a branch wins over a PR) */
    async bundleHeads(bundleId: number): Promise<Map<number, string>> {
      const rows = await knex(T.branches)
        .where({ bundle_id: bundleId, alive: true })
        .orderBy('is_pr', 'desc'); // PRs first, so branches overwrite them
      return new Map(
        rows.map((r: any) => [r.repo_id as number, r.head_sha as string]),
      );
    },

    async listBundles(
      projectId: number,
      opts: { search?: string; limit?: number } = {},
    ) {
      const q = knex(T.bundles)
        .where({ project_id: projectId })
        .orderBy([
          { column: 'sticky', order: 'desc' },
          { column: 'updated', order: 'desc' },
        ])
        .limit(opts.limit ?? 50);
      if (opts.search)
        q.where('name', 'like', `%${opts.search.replace(/[%_]/g, '')}%`);
      const rows = await q;
      return Promise.all(rows.map((r: any) => store.bundleFromRow(r)));
    },
    async getBundle(id: number) {
      const r = await knex(T.bundles).where({ id }).first();
      return r ? store.bundleFromRow(r) : undefined;
    },
    async bundleFromRow(r: any): Promise<RunbotBundle> {
      const branches = (
        await knex(T.branches).where({ bundle_id: r.id }).orderBy('repo_id')
      ).map(toBranch);
      return {
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        isBase: bool(r.is_base),
        baseName: r.base_name,
        version: r.version,
        sticky: bool(r.sticky),
        branches,
        lastBatch: r.last_batch_id
          ? await store.getBatch(r.last_batch_id)
          : undefined,
        updated: r.updated,
      };
    },

    // --- batches
    /** A new batch, unless the bundle already has one gathering commits */
    async requestBatch(bundleId: number, createdAt?: string): Promise<number> {
      const preparing = await knex(T.batches)
        .where({ bundle_id: bundleId, state: 'preparing' })
        .first();
      if (preparing) return preparing.id;
      const [row] = await knex(T.batches)
        .insert({
          bundle_id: bundleId,
          state: 'preparing',
          created: createdAt ?? now(),
        })
        .returning('id');
      const id = (typeof row === 'object' ? row.id : row) as number;
      await knex(T.bundles)
        .where({ id: bundleId })
        .update({ last_batch_id: id, updated: now() });
      return id;
    },
    async preparingBatchesDue(): Promise<{ id: number; bundleId: number }[]> {
      const rows = await knex(T.batches)
        .join(T.bundles, `${T.batches}.bundle_id`, `${T.bundles}.id`)
        .join(T.projects, `${T.bundles}.project_id`, `${T.projects}.id`)
        .where(`${T.batches}.state`, 'preparing')
        .select(
          `${T.batches}.id`,
          `${T.batches}.bundle_id`,
          `${T.batches}.created`,
          `${T.projects}.batch_delay`,
        );
      const t = Date.now();
      return rows
        .filter((r: any) => t - Date.parse(r.created) >= r.batch_delay * 1000)
        .map((r: any) => ({ id: r.id, bundleId: r.bundle_id }));
    },
    async setBatchReady(
      id: number,
      commits: BatchCommit[],
      slots: { triggerId: number; buildId?: number; skipReason?: string }[],
    ) {
      await knex.transaction(async trx => {
        await trx(T.batchCommits).where({ batch_id: id }).delete();
        if (commits.length)
          await trx(T.batchCommits).insert(
            commits.map(c => ({
              batch_id: id,
              repo_id: c.repoId,
              sha: c.sha,
              match: c.match,
            })),
          );
        await trx(T.slots).where({ batch_id: id }).delete();
        if (slots.length)
          await trx(T.slots).insert(
            slots.map(s => ({
              batch_id: id,
              trigger_id: s.triggerId,
              build_id: s.buildId ?? null,
              skip_reason: s.skipReason ?? null,
            })),
          );
        await trx(T.batches)
          .where({ id })
          .update({ state: 'ready', ready_at: now() });
      });
    },
    async setBatchState(id: number, state: BatchState) {
      await knex(T.batches).where({ id }).update({ state });
    },
    async getBatch(id: number): Promise<RunbotBatch | undefined> {
      const b = await knex(T.batches).where({ id }).first();
      if (!b) return undefined;
      const commits = await knex(T.batchCommits)
        .join(T.repos, `${T.batchCommits}.repo_id`, `${T.repos}.id`)
        .where({ batch_id: id })
        .orderBy(`${T.repos}.is_server`, 'desc')
        .select(
          `${T.batchCommits}.*`,
          `${T.repos}.name as repo_name`,
          `${T.repos}.slug`,
        );
      const slotRows = await knex(T.slots).where({ batch_id: id });
      const names = await triggerNames(slotRows.map((s: any) => s.trigger_id));
      const buildIds = slotRows.map((s: any) => s.build_id).filter(Boolean);
      const builds = buildIds.length
        ? await knex(T.builds).whereIn('id', buildIds)
        : [];
      const byId = new Map(builds.map((r: any) => [r.id, r]));
      const slots: BatchSlot[] = slotRows
        .map((s: any) => ({
          triggerId: s.trigger_id,
          triggerName: names.get(s.trigger_id) ?? `#${s.trigger_id}`,
          buildId: s.build_id ?? undefined,
          skipReason: s.skip_reason ?? undefined,
          build:
            s.build_id && byId.get(s.build_id)
              ? toSummary(byId.get(s.build_id), names.get(s.trigger_id) ?? '')
              : undefined,
        }))
        .sort((a: BatchSlot, b: BatchSlot) =>
          a.triggerName.localeCompare(b.triggerName),
        );
      return {
        id: b.id,
        bundleId: b.bundle_id,
        state: b.state as BatchState,
        created: b.created,
        readyAt: b.ready_at ?? undefined,
        commits: commits.map((c: any) => ({
          repoId: c.repo_id,
          repoName: c.repo_name,
          slug: c.slug,
          sha: c.sha,
          match: c.match,
        })),
        slots,
      };
    },
    async listBatches(bundleId: number, limit = 20) {
      const rows = await knex(T.batches)
        .where({ bundle_id: bundleId })
        .orderBy('id', 'desc')
        .limit(limit);
      return Promise.all(
        rows.map((r: any) => store.getBatch(r.id).then(b => b!)),
      );
    },
    /**
     * Older batches of a bundle are superseded: their builds that haven't
     * started, and that no newer batch uses, are skipped (runbot does the same
     * for non-sticky bundles).
     */
    async skipSuperseded(
      bundleId: number,
      newBatchId: number,
    ): Promise<number[]> {
      const older = await knex(T.batches)
        .where({ bundle_id: bundleId })
        .where('id', '<', newBatchId)
        .whereIn('state', ['ready', 'preparing']);
      const skipped: number[] = [];
      for (const batch of older) {
        const ids = (
          await knex(T.slots)
            .where({ batch_id: batch.id })
            .whereNotNull('build_id')
        ).map((s: any) => s.build_id);
        const usedNow = new Set(
          (
            await knex(T.slots)
              .where({ batch_id: newBatchId })
              .whereNotNull('build_id')
          ).map((s: any) => s.build_id),
        );
        const toSkip = ids.filter((id: number) => !usedNow.has(id));
        if (toSkip.length) {
          const pending = await knex(T.builds)
            .whereIn('id', toSkip)
            .where({ local_state: 'pending' })
            .select('id');
          if (pending.length) {
            await knex(T.builds)
              .whereIn(
                'id',
                pending.map((p: any) => p.id),
              )
              .update({
                local_state: 'done',
                result: 'skipped',
                finished: now(),
              });
            skipped.push(...pending.map((p: any) => p.id));
          }
        }
        await knex(T.batches)
          .where({ id: batch.id })
          .update({ state: batch.state === 'preparing' ? 'skipped' : 'done' });
      }
      return skipped;
    },

    // --- builds
    /**
     * The newest build with these params that ran or is running, to reuse
     * (killed and skipped builds never finished, so they don't count)
     */
    async findReusableBuild(paramsHash: string) {
      return knex(T.builds)
        .where({ params_hash: paramsHash })
        .where(q =>
          q.whereNull('result').orWhereIn('result', ['ok', 'warn', 'ko']),
        )
        .orderBy('id', 'desc')
        .first();
    },
    async createBuild(b: {
      projectId: number;
      triggerId: number;
      paramsHash: string;
      params: BuildParams;
    }) {
      const [row] = await knex(T.builds)
        .insert({
          project_id: b.projectId,
          trigger_id: b.triggerId,
          params_hash: b.paramsHash,
          params: json(b.params),
          local_state: 'pending',
          requested: now(),
          kill_requested: false,
          log_count: 0,
        })
        .returning('id');
      return (typeof row === 'object' ? row.id : row) as number;
    },
    async getBuild(id: number): Promise<RunbotBuild | undefined> {
      const r = await knex(T.builds).where({ id }).first();
      if (!r) return undefined;
      const names = await triggerNames([r.trigger_id]);
      const batchIds = (
        await knex(T.slots).where({ build_id: id }).select('batch_id')
      ).map((s: any) => s.batch_id);
      return {
        ...toSummary(r, names.get(r.trigger_id) ?? ''),
        projectId: r.project_id,
        params: parse<BuildParams>(r.params, {
          version: '',
          commits: [],
          steps: [],
        }),
        paramsHash: r.params_hash,
        killRequested: bool(r.kill_requested),
        batchIds,
      };
    },
    async listBuilds(
      opts: {
        projectId?: number;
        states?: BuildLocalState[];
        limit?: number;
      } = {},
    ) {
      const q = knex(T.builds)
        .orderBy('id', 'desc')
        .limit(opts.limit ?? 50);
      if (opts.projectId !== undefined) q.where({ project_id: opts.projectId });
      if (opts.states?.length) q.whereIn('local_state', opts.states);
      const rows = await q;
      const names = await triggerNames(rows.map((r: any) => r.trigger_id));
      return rows.map((r: any) => toSummary(r, names.get(r.trigger_id) ?? ''));
    },
    /** Point every batch that used `from` at `to` (after a rebuild) */
    async replaceInSlots(from: number, to: number) {
      await knex(T.slots).where({ build_id: from }).update({ build_id: to });
    },
    /** Atomically take the oldest pending build for a host */
    async claimBuild(host: string): Promise<RunbotBuild | undefined> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const next = await knex(T.builds)
          .where({ local_state: 'pending', kill_requested: false })
          .orderBy('id')
          .first('id');
        if (!next) return undefined;
        const n = await knex(T.builds)
          .where({ id: next.id, local_state: 'pending' })
          .update({ local_state: 'testing', host, started: now() });
        if (n === 1) return store.getBuild(next.id);
      }
      return undefined;
    },
    async appendLogs(
      buildId: number,
      lines: {
        level: LogLevel;
        logger: string;
        message: string;
        created?: string;
      }[],
    ) {
      const r = await knex(T.builds)
        .where({ id: buildId })
        .first('log_count', 'error_summary');
      if (!r) return;
      const room = Math.max(0, MAX_LOG_LINES - r.log_count);
      const keep = lines.slice(0, room);
      if (keep.length)
        await knex.batchInsert(
          T.logs,
          keep.map(l => ({
            build_id: buildId,
            level: l.level,
            logger: l.logger.slice(0, 250),
            message: l.message.slice(0, 20000),
            created: l.created ?? now(),
          })),
          200,
        );
      const firstError = !r.error_summary
        ? lines.find(l => l.level === 'ERROR' || l.level === 'CRITICAL')
        : undefined;
      await knex(T.builds)
        .where({ id: buildId })
        .update({
          log_count: r.log_count + lines.length,
          ...(firstError
            ? { error_summary: firstError.message.split('\n')[0].slice(0, 500) }
            : {}),
        });
    },
    async getLogs(
      buildId: number,
      opts: { after?: number; limit?: number; levels?: LogLevel[] } = {},
    ) {
      const q = knex(T.logs)
        .where({ build_id: buildId })
        .where('id', '>', opts.after ?? 0)
        .orderBy('id')
        .limit(opts.limit ?? 1000);
      if (opts.levels?.length) q.whereIn('level', opts.levels);
      return (await q).map(
        (r: any): RunbotBuildLog => ({
          id: r.id,
          buildId: r.build_id,
          level: r.level,
          logger: r.logger,
          message: r.message,
          created: r.created,
        }),
      );
    },
    async finishBuild(id: number, result: BuildResult, errorSummary?: string) {
      await knex(T.builds)
        .where({ id })
        .update({
          local_state: 'done',
          result,
          finished: now(),
          ...(errorSummary
            ? { error_summary: errorSummary.slice(0, 500) }
            : {}),
        });
    },
    async requestKill(id: number) {
      const r = await knex(T.builds).where({ id }).first('local_state');
      if (!r) return false;
      if (r.local_state === 'pending') {
        await knex(T.builds).where({ id }).update({
          local_state: 'done',
          result: 'killed',
          finished: now(),
          kill_requested: true,
        });
      } else {
        await knex(T.builds).where({ id }).update({ kill_requested: true });
      }
      return true;
    },
    /** Builds a host should stop */
    async killRequestedFor(host: string): Promise<number[]> {
      return (
        await knex(T.builds)
          .where({ host, kill_requested: true })
          .whereIn('local_state', ['testing', 'running'])
          .select('id')
      ).map((r: any) => r.id);
    },
    /** Builds "testing" on hosts that stopped reporting go back in the queue */
    async requeueOrphans(staleBefore: string): Promise<number[]> {
      const stale = (
        await knex(T.hosts).where('last_seen', '<', staleBefore).select('name')
      ).map((h: any) => h.name);
      if (!stale.length) return [];
      const rows = await knex(T.builds)
        .whereIn('host', stale)
        .where({ local_state: 'testing' })
        .select('id');
      if (rows.length)
        await knex(T.builds)
          .whereIn(
            'id',
            rows.map((r: any) => r.id),
          )
          .update({ local_state: 'pending', host: null, started: null });
      return rows.map((r: any) => r.id);
    },

    // --- hosts
    async heartbeat(h: {
      name: string;
      workers: number;
      running: number[];
      version: string;
    }) {
      const row = {
        last_seen: now(),
        workers: h.workers,
        running: json(h.running),
        version: h.version,
      };
      const existing = await knex(T.hosts).where({ name: h.name }).first();
      if (existing) await knex(T.hosts).where({ name: h.name }).update(row);
      else await knex(T.hosts).insert({ name: h.name, ...row });
    },
    async listHosts(): Promise<RunbotHost[]> {
      return (await knex(T.hosts).orderBy('name')).map((r: any) => ({
        name: r.name,
        lastSeen: r.last_seen,
        workers: r.workers,
        running: parse(r.running, []),
        version: r.version,
      }));
    },

    async stats(projectId?: number) {
      const q = knex(T.builds);
      if (projectId !== undefined) q.where({ project_id: projectId });
      const rows = await q
        .clone()
        .select('local_state', 'result')
        .count({ n: '*' })
        .groupBy('local_state', 'result');
      const count = (f: (r: any) => boolean) =>
        rows.filter(f).reduce((s: number, r: any) => s + Number(r.n), 0);
      return {
        pending: count(r => r.local_state === 'pending'),
        testing: count(r => r.local_state === 'testing'),
        ok: count(r => r.result === 'ok'),
        warn: count(r => r.result === 'warn'),
        ko: count(r => r.result === 'ko'),
        killed: count(r => r.result === 'killed'),
        skipped: count(r => r.result === 'skipped'),
      };
    },
  };
  return store;
}
