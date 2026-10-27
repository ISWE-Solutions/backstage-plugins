import express from 'express';
import { AddressInfo } from 'node:net';
import knexFactory from 'knex';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';
import { createRunbotStore } from './store';
import { Leader } from './leader';
import { StatusReporter } from './statuses';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;
const sha = (c: string) => c.repeat(40);

// x-test-user: a signed-in user; x-test-service: a service token with that subject
const httpAuth = {
  credentials: jest.fn(
    async (req: express.Request, opts: { allow: string[] }) => {
      const svc = req.headers['x-test-service'];
      if (svc && opts.allow.includes('service'))
        return { principal: { type: 'service', subject: String(svc) } };
      if (req.headers['x-test-user'] && opts.allow.includes('user'))
        return {
          principal: { type: 'user', userEntityRef: 'user:default/tester' },
        };
      throw Object.assign(new Error('Not allowed'), {
        name: 'NotAllowedError',
      });
    },
  ),
  issueUserCookie: jest.fn(),
} as any;
let allow = true;
const permissions = {
  authorize: jest.fn(async () => [
    { result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY },
  ]),
  authorizeConditional: jest.fn(),
} as any;

const github = {
  listBranches: jest.fn(async () => [{ name: 'main', sha: sha('d') }]),
  listOpenPulls: jest.fn(async () => []),
  setStatus: jest.fn(async () => {}),
  getRepo: jest.fn(async (slug: string) => {
    if (slug.endsWith('secret')) throw new Error('HTTP 404');
    return { defaultBranch: 'main', private: false };
  }),
};

async function start() {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  const store = await createRunbotStore({ getClient: async () => knex as any });
  const statuses = new StatusReporter(store, github, logger, {
    enabled: false,
    buildUrl: String,
  });
  const leader = new Leader(store, github, statuses, logger);
  const app = express().use(
    await createRouter({
      store,
      leader,
      statuses,
      github,
      httpAuth,
      permissions,
      logger,
      builderSubject: 'odoo-runbot-builder',
    }),
  );
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status =
      { InputError: 400, NotAllowedError: 403, NotFoundError: 404 }[
        err.name as string
      ] ?? 500;
    res.status(status).json({ error: err.message });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { 'x-test-user': '1' },
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { knex, store, leader, server, call };
}

describe('router', () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    allow = true;
    ctx = await start();
  });
  afterEach(async () => {
    ctx.server.close();
    await ctx.knex.destroy();
  });

  const project = () =>
    ctx.call('POST', '/projects', {
      name: 'ISWE 19',
      baseBranches: ['19.0'],
      masterBase: '19.0',
      batchDelay: 0,
    });

  it('creates projects and repositories with a trigger', async () => {
    const p = await project();
    expect(p.status).toBe(201);
    // a trigger needs odoo first
    const early = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'ISWE-Solutions/iswe_meal_addons',
      createTrigger: true,
    });
    expect(early).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('odoo/odoo') },
    });
    expect(
      (
        await ctx.call('POST', '/repos', {
          projectId: p.body.id,
          slug: 'odoo/odoo',
          isServer: true,
        })
      ).status,
    ).toBe(201);
    const meal = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'ISWE-Solutions/iswe_meal_addons',
      createTrigger: true,
    });
    expect(meal.status).toBe(201);
    expect(meal.body.trigger).toMatchObject({
      name: 'iswe_meal_addons',
      ciContext: 'ci/runbot-iswe-meal-addons',
    });
    expect(meal.body.repo).toMatchObject({
      defaultBranch: 'main',
      isServer: false,
    });
    const dup = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'iswe-solutions/ISWE_MEAL_ADDONS',
    });
    expect(dup.status).toBe(400);
  });

  it('rejects bad input, unreadable repositories and missing permissions', async () => {
    const p = await project();
    expect(
      (
        await ctx.call('POST', '/repos', {
          projectId: p.body.id,
          slug: '../etc',
        })
      ).status,
    ).toBe(400);
    const secret = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'org/secret',
    });
    expect(secret).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('repo scope') },
    });
    expect(
      (await ctx.call('POST', '/projects', { name: 'x', baseBranches: [] }))
        .status,
    ).toBe(400);
    allow = false;
    expect(
      (
        await ctx.call('POST', '/projects', {
          name: 'Other',
          baseBranches: ['18.0'],
        })
      ).status,
    ).toBe(403);
    expect((await ctx.call('POST', '/builds/1/kill')).status).toBe(403);
    // reading stays open
    expect((await ctx.call('GET', '/projects')).status).toBe(200);
  });

  it('validates executors before creating anything', async () => {
    const p = await project();
    await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'odoo/odoo',
      isServer: true,
    });
    const bad = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'ISWE-Solutions/iswe_sdp_addons',
      createTrigger: true,
      executor: 'kubernetes',
    });
    expect(bad.status).toBe(400);
    expect(
      (await ctx.call('GET', `/projects/${p.body.id}`)).body.repos,
    ).toHaveLength(1);
    const ok = await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'ISWE-Solutions/iswe_sdp_addons',
      createTrigger: true,
      executor: 'proxmox',
    });
    expect(ok.body.trigger.executor).toBe('proxmox');
    const patched = await ctx.call('PATCH', `/triggers/${ok.body.trigger.id}`, {
      executor: 'docker',
    });
    expect(patched.body.executor).toBe('docker');
  });

  it('lets only the builder token use builder endpoints', async () => {
    expect(
      (await ctx.call('POST', '/builder/claim', { host: 'b1' })).status,
    ).toBe(403);
    expect(
      (
        await ctx.call(
          'POST',
          '/builder/claim',
          { host: 'b1' },
          { 'x-test-service': 'plugin:catalog' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx.call(
          'POST',
          '/builder/claim',
          { host: 'b1' },
          { 'x-test-service': 'odoo-runbot-builder' },
        )
      ).status,
    ).toBe(204);
  });

  it('runs a build from claim to result', async () => {
    const p = await project();
    await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'odoo/odoo',
      isServer: true,
    });
    await ctx.call('POST', '/repos', {
      projectId: p.body.id,
      slug: 'ISWE-Solutions/iswe_meal_addons',
      createTrigger: true,
    });
    (github.listBranches as jest.Mock).mockImplementation(
      async (slug: string) =>
        slug === 'odoo/odoo'
          ? [{ name: '19.0', sha: sha('a') }]
          : [{ name: 'main', sha: sha('d') }],
    );
    await ctx.leader.pollAll();
    await ctx.leader.prepareBatches();
    const b = { 'x-test-service': 'odoo-runbot-builder' };
    const hb = await ctx.call(
      'POST',
      '/builder/heartbeat',
      { host: 'runbot-1', workers: 2, running: [] },
      b,
    );
    expect(hb.body).toEqual({ kill: [] });
    const claim = await ctx.call(
      'POST',
      '/builder/claim',
      { host: 'runbot-1' },
      b,
    );
    expect(claim.status).toBe(200);
    expect(claim.body.dbName).toBe(`runbot_${claim.body.buildId}_all`);
    expect(
      claim.body.params.commits.map((c: any) => [
        c.repoName,
        c.isServer,
        c.tested,
      ]),
    ).toEqual([
      ['odoo', true, false],
      ['iswe_meal_addons', false, true],
    ]);
    const id = claim.body.buildId;
    await ctx.call(
      'POST',
      `/builder/builds/${id}/logs`,
      {
        lines: [
          { level: 'WARNING', logger: 'odoo.modules', message: 'deprecated' },
        ],
      },
      b,
    );
    expect(
      (
        await ctx.call(
          'POST',
          `/builder/builds/${id}/result`,
          { result: 'great' },
          b,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx.call(
          'POST',
          `/builder/builds/${id}/result`,
          { result: 'warn' },
          b,
        )
      ).status,
    ).toBe(204);
    const build = await ctx.call('GET', `/builds/${id}`);
    expect(build.body).toMatchObject({ localState: 'done', result: 'warn' });
    const logs = await ctx.call('GET', `/builds/${id}/logs?levels=WARNING`);
    expect(logs.body.map((l: any) => l.message)).toEqual(['deprecated']);
    // a rebuild replaces the build in its batches
    const rebuilt = await ctx.call('POST', `/builds/${id}/rebuild`);
    const base = await ctx.call('GET', `/projects/${p.body.id}/bundles`);
    expect(base.body[0].lastBatch.slots[0].buildId).toBe(rebuilt.body.buildId);
  });
});
