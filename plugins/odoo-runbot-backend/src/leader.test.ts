import knexFactory from 'knex';
import { createRunbotStore, RunbotStore } from './store';
import { Leader, paramsHash } from './leader';
import { GithubClient } from './github';
import { StatusReporter } from './statuses';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;

function fakeGithub() {
  const branches: Record<string, { name: string; sha: string }[]> = {};
  const pulls: Record<string, any[]> = {};
  const statuses: any[] = [];
  const github: GithubClient = {
    listBranches: async slug => branches[slug] ?? [],
    listOpenPulls: async slug => pulls[slug] ?? [],
    setStatus: async (slug, s, st) => {
      statuses.push({ slug, sha: s, ...st });
    },
    getRepo: async () => ({ defaultBranch: 'main', private: true }),
  };
  return { github, branches, pulls, statuses };
}

async function setup() {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  const store = await createRunbotStore({ getClient: async () => knex as any });
  const gh = fakeGithub();
  const statuses = new StatusReporter(store, gh.github, logger, {
    enabled: true,
    buildUrl: id => `https://bs/odoo?runbotBuild=${id}`,
  });
  const leader = new Leader(store, gh.github, statuses, logger);
  const project = await store.createProject({
    name: 'ISWE 19',
    baseBranches: ['19.0'],
    masterBase: '19.0',
    batchDelay: 0,
  });
  const odoo = await store.createRepo({
    projectId: project.id,
    name: 'odoo',
    slug: 'odoo/odoo',
    isServer: true,
    addonsSubdir: '',
    defaultBranch: 'master',
  });
  const meal = await store.createRepo({
    projectId: project.id,
    name: 'iswe_meal_addons',
    slug: 'ISWE-Solutions/iswe_meal_addons',
    isServer: false,
    addonsSubdir: '',
    defaultBranch: 'main',
  });
  const sdp = await store.createRepo({
    projectId: project.id,
    name: 'iswe_sdp_addons',
    slug: 'ISWE-Solutions/iswe_sdp_addons',
    isServer: false,
    addonsSubdir: '',
    defaultBranch: 'main',
  });
  const trigger = (repoId: number, name: string) =>
    store.createTrigger({
      projectId: project.id,
      name,
      repoIds: [repoId],
      dependencyRepoIds: [odoo.id],
      steps: [
        {
          type: 'install_test',
          modules: ['*'],
          excludeModules: [],
          testTags: '',
          demo: true,
          timeout: 3600,
        },
      ],
      ciContext: `ci/runbot-${name}`,
      executor: 'docker',
      baseOnly: false,
      active: true,
      sequence: 10,
    });
  const tMeal = await trigger(meal.id, 'meal');
  const tSdp = await trigger(sdp.id, 'sdp');
  gh.branches['odoo/odoo'] = [
    { name: '19.0', sha: sha('a') },
    { name: '18.0', sha: sha('b') },
    { name: 'master', sha: sha('c') },
  ];
  gh.branches['ISWE-Solutions/iswe_meal_addons'] = [
    { name: 'main', sha: sha('d') },
  ];
  gh.branches['ISWE-Solutions/iswe_sdp_addons'] = [
    { name: 'main', sha: sha('e') },
  ];
  return { knex, store, gh, leader, project, odoo, meal, sdp, tMeal, tSdp };
}

const cycle = async (leader: Leader) => {
  await leader.pollAll();
  await leader.prepareBatches();
};

describe('leader', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let store: RunbotStore;
  beforeEach(async () => {
    ctx = await setup();
    store = ctx.store;
  });
  afterEach(() => ctx.knex.destroy());

  it("puts each addons repo's main in the 19.0 base bundle with odoo, tracking only odoo base branches", async () => {
    await cycle(ctx.leader);
    const bundles = await store.listBundles(ctx.project.id);
    expect(bundles.map(b => [b.name, b.isBase, b.version])).toEqual([
      ['19.0', true, '19.0'],
    ]);
    const base = bundles[0];
    expect(base.branches.map(b => b.name).sort()).toEqual([
      '19.0',
      'main',
      'main',
    ]);
    const batch = base.lastBatch!;
    expect(batch.state).toBe('ready');
    expect(batch.commits.map(c => [c.repoName, c.sha[0], c.match])).toEqual([
      ['odoo', 'a', 'head'],
      ['iswe_meal_addons', 'd', 'head'],
      ['iswe_sdp_addons', 'e', 'head'],
    ]);
    expect(batch.slots.map(s => [s.triggerName, s.build?.localState])).toEqual([
      ['meal', 'pending'],
      ['sdp', 'pending'],
    ]);
    // pending statuses on the tested commits only, never on odoo
    expect(
      ctx.gh.statuses.map(s => [s.slug, s.context, s.state]).sort(),
    ).toEqual([
      ['ISWE-Solutions/iswe_meal_addons', 'ci/runbot-meal', 'pending'],
      ['ISWE-Solutions/iswe_sdp_addons', 'ci/runbot-sdp', 'pending'],
    ]);
  });

  it('does not create batches when only a dependency (odoo) moves', async () => {
    await cycle(ctx.leader);
    ctx.gh.branches['odoo/odoo'] = [{ name: '19.0', sha: sha('1') }];
    await cycle(ctx.leader);
    expect(await store.listBuilds()).toHaveLength(2);
  });

  it('reuses identical builds and only rebuilds what changed', async () => {
    await cycle(ctx.leader);
    const before = await store.listBuilds();
    expect(before).toHaveLength(2);
    // a new commit on meal: one new build; sdp's is reused
    ctx.gh.branches['ISWE-Solutions/iswe_meal_addons'] = [
      { name: 'main', sha: sha('f') },
    ];
    await cycle(ctx.leader);
    expect(await store.listBuilds()).toHaveLength(3);
    const base = (await store.listBundles(ctx.project.id))[0];
    const sdpBuild = before.find(b => b.triggerName === 'sdp')!;
    expect(
      base.lastBatch!.slots.find(s => s.triggerName === 'sdp')!.buildId,
    ).toBe(sdpBuild.id);
    // a base bundle is sticky: the older meal build still runs, as in runbot
    const oldMeal = before.find(b => b.triggerName === 'meal')!;
    expect((await store.getBuild(oldMeal.id))!.localState).toBe('pending');
  });

  it('skips superseded builds on feature branches', async () => {
    await cycle(ctx.leader);
    ctx.gh.branches['ISWE-Solutions/iswe_meal_addons'] = [
      { name: 'main', sha: sha('d') },
      { name: 'budgets', sha: sha('5') },
    ];
    await cycle(ctx.leader);
    const first = (
      await store.listBundles(ctx.project.id, { search: 'budgets' })
    )[0];
    const firstBuild = first.lastBatch!.slots.find(
      s => s.triggerName === 'meal',
    )!.buildId!;
    ctx.gh.branches['ISWE-Solutions/iswe_meal_addons'] = [
      { name: 'main', sha: sha('d') },
      { name: 'budgets', sha: sha('6') },
    ];
    await cycle(ctx.leader);
    expect((await store.getBuild(firstBuild))!.result).toBe('skipped');
  });

  it('puts a pull request in the bundle of its head branch, with the base for the other repos', async () => {
    await cycle(ctx.leader);
    ctx.gh.pulls['ISWE-Solutions/iswe_meal_addons'] = [
      {
        number: 7,
        title: 'Budgets',
        author: 'thom',
        draft: false,
        target: 'main',
        headRef: 'budgets',
        headSha: sha('9'),
        headSlug: 'ISWE-Solutions/iswe_meal_addons',
      },
    ];
    await cycle(ctx.leader);
    const bundle = (
      await store.listBundles(ctx.project.id, { search: 'budgets' })
    )[0];
    expect(bundle.branches.map(b => [b.name, b.isPr, b.prNumber])).toEqual([
      ['#7', true, 7],
    ]);
    expect(bundle.lastBatch!.commits.map(c => [c.repoName, c.match])).toEqual([
      ['odoo', 'base'],
      ['iswe_meal_addons', 'head'],
      ['iswe_sdp_addons', 'base'],
    ]);
    expect(
      bundle.lastBatch!.slots.map(s => [
        s.triggerName,
        Boolean(s.buildId),
        s.skipReason ?? '',
      ]),
    ).toEqual([
      ['meal', true, ''],
      ['sdp', false, 'No branch of the tested repositories in this bundle'],
    ]);
  });

  it('lets builders claim, log and finish builds, reporting statuses', async () => {
    await cycle(ctx.leader);
    const claimed = await store.claimBuild('runbot-1');
    expect(claimed?.localState).toBe('testing');
    await store.appendLogs(claimed!.id, [
      { level: 'INFO', logger: 'odoo', message: 'loading' },
      {
        level: 'ERROR',
        logger: 'odoo.addons.meal.tests',
        message: 'FAIL: test_budget\nTraceback',
      },
    ]);
    await store.finishBuild(claimed!.id, 'ko');
    const done = await store.getBuild(claimed!.id);
    expect(done).toMatchObject({
      localState: 'done',
      result: 'ko',
      errorSummary: 'FAIL: test_budget',
    });
    expect((await store.getLogs(claimed!.id)).map(l => l.level)).toEqual([
      'INFO',
      'ERROR',
    ]);
    // a second builder can't take the same build
    const other = await store.claimBuild('runbot-2');
    expect(other?.id).not.toBe(claimed!.id);
  });

  it('kills pending builds at once and running ones through the builder', async () => {
    await cycle(ctx.leader);
    const [a, b] = await store.listBuilds();
    await store.claimBuild('runbot-1');
    await store.requestKill(a.id);
    await store.requestKill(b.id);
    const states = await Promise.all(
      [a.id, b.id].map(id => store.getBuild(id)),
    );
    const running = states.find(s => s!.localState === 'testing')!;
    const pending = states.find(s => s!.localState === 'done')!;
    expect(pending.result).toBe('killed');
    expect(await store.killRequestedFor('runbot-1')).toEqual([running.id]);
  });

  it('requeues builds of builders that went silent', async () => {
    await cycle(ctx.leader);
    await store.heartbeat({
      name: 'runbot-1',
      workers: 2,
      running: [],
      version: '1',
    });
    const b = await store.claimBuild('runbot-1');
    await ctx
      .knex('runbot_hosts')
      .update({ last_seen: '2000-01-01T00:00:00.000Z' });
    expect(await ctx.leader.requeueOrphans()).toEqual([b!.id]);
    expect((await store.getBuild(b!.id))!.localState).toBe('pending');
  });

  it('hashes params independently of key order', () => {
    expect(paramsHash({ a: 1, b: [1, 2] })).toBe(
      paramsHash({ b: [1, 2], a: 1 }),
    );
  });

  it('gives builders only the builds they can run, and keeps executors apart', async () => {
    await store.updateTrigger(ctx.tSdp.id, { executor: 'proxmox' });
    await cycle(ctx.leader);
    const builds = await Promise.all(
      (await store.listBuilds()).map(b => store.getBuild(b.id)),
    );
    expect(
      builds.map(b => [b!.triggerName, b!.params.executor]).sort(),
    ).toEqual([
      ['meal', 'docker'],
      ['sdp', 'proxmox'],
    ]);
    // a Docker-only builder never gets the proxmox build
    const first = await store.claimBuild('docker-only', ['docker']);
    expect(first?.params.executor).toBe('docker');
    expect(await store.claimBuild('docker-only', ['docker'])).toBeUndefined();
    const ct = await store.claimBuild('both', ['docker', 'proxmox']);
    expect(ct?.params.executor).toBe('proxmox');
    // same commits, different executor: a different build
    expect(paramsHash({ ...builds[0]!.params, executor: 'docker' })).not.toBe(
      paramsHash({ ...builds[0]!.params, executor: 'proxmox' }),
    );
  });

  it('adds the executor columns to a database from the first release', async () => {
    const knex = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('runbot_triggers', t => {
      t.increments('id');
      t.integer('project_id');
      t.string('name');
      t.text('repo_ids');
      t.text('dependency_repo_ids');
      t.text('steps');
      t.string('ci_context');
      t.boolean('base_only');
      t.boolean('active');
      t.integer('sequence');
    });
    await knex('runbot_triggers').insert({
      project_id: 1,
      name: 'old',
      repo_ids: '[1]',
      dependency_repo_ids: '[]',
      steps: '[]',
      ci_context: 'ci/runbot-old',
      base_only: false,
      active: true,
      sequence: 10,
    });
    const old = await createRunbotStore({ getClient: async () => knex as any });
    expect((await old.listTriggers())[0].executor).toBe('docker');
    await knex.destroy();
  });
});
