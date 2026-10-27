import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import {
  AddRepoRequest,
  CreateProjectRequest,
  CreateTriggerRequest,
  LogLevel,
  TriggerStep,
  buildDbName,
  ciContextFor,
  defaultInstallTestStep,
  runbotBuildManagePermission,
  runbotConfigurePermission,
} from '@iswesolutions/plugin-odoo-runbot-common';
import { GithubClient } from './github';
import { Leader } from './leader';
import { RunbotStore } from './store';
import { StatusReporter } from './statuses';

// GitHub owners: letters, digits, hyphens; repo names may have dots but aren't "." or ".."
const SLUG = /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const LEVELS: LogLevel[] = [
  'DEBUG',
  'INFO',
  'WARNING',
  'ERROR',
  'CRITICAL',
  'RUNBOT',
];

const int = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new InputError(`${name} must be a positive integer`);
  return n;
};
const str = (v: unknown, name: string, re?: RegExp) => {
  if (typeof v !== 'string' || !v.trim())
    throw new InputError(`${name} is required`);
  const s = v.trim();
  if (re && !re.test(s)) throw new InputError(`${name} is not valid: ${s}`);
  return s;
};

export function parseSteps(v: unknown): TriggerStep[] {
  if (v === undefined) return [defaultInstallTestStep()];
  if (!Array.isArray(v) || !v.length)
    throw new InputError('steps must be a non-empty list');
  return v.map((s: any) => {
    if (s?.type !== 'install_test')
      throw new InputError(`Unknown step type ${s?.type}`);
    const globs = (x: unknown) =>
      Array.isArray(x)
        ? x.map(String).filter(g => /^[A-Za-z0-9_*?]+$/.test(g))
        : [];
    const d = defaultInstallTestStep();
    return {
      type: 'install_test',
      modules: s.modules === undefined ? d.modules : globs(s.modules),
      excludeModules: globs(s.excludeModules),
      testTags:
        typeof s.testTags === 'string' &&
        /^[A-Za-z0-9_,:/.*+-]*$/.test(s.testTags)
          ? s.testTags
          : '',
      demo: s.demo === undefined ? d.demo : Boolean(s.demo),
      timeout:
        Number.isInteger(s.timeout) && s.timeout >= 60 && s.timeout <= 6 * 3600
          ? s.timeout
          : d.timeout,
    };
  });
}

export interface RouterOptions {
  store: RunbotStore;
  leader: Leader;
  statuses: StatusReporter;
  github: GithubClient;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  logger: LoggerService;
  builderSubject: string;
}

export async function createRouter(
  opts: RouterOptions,
): Promise<express.Router> {
  const {
    store,
    leader,
    statuses,
    github,
    httpAuth,
    permissions,
    logger,
    builderSubject,
  } = opts;
  const router = Router();
  router.use(express.json({ limit: '5mb' }));

  const user = (req: express.Request) =>
    httpAuth.credentials(req, { allow: ['user'] });
  const authorize = async (
    req: express.Request,
    permission: BasicPermission,
  ) => {
    const credentials = await user(req);
    const [decision] = await permissions.authorize([{ permission }], {
      credentials,
    });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Missing permission ${permission.name}`);
    }
    return credentials;
  };
  const builder = async (req: express.Request) => {
    const c = await httpAuth.credentials(req, { allow: ['service'] });
    if ((c.principal as { subject?: string }).subject !== builderSubject) {
      throw new NotAllowedError('Only runbot builders may call this');
    }
  };

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ---------------------------------------------------------------- reading
  router.get('/projects', async (req, res) => {
    await user(req);
    res.json(await store.listProjects());
  });

  router.get('/projects/:id', async (req, res) => {
    await user(req);
    const id = int(req.params.id, 'id');
    const project = await store.getProject(id);
    if (!project) throw new NotFoundError(`No project ${id}`);
    res.json({
      project,
      repos: await store.listRepos(id),
      triggers: await store.listTriggers(id),
      stats: await store.stats(id),
    });
  });

  router.get('/projects/:id/bundles', async (req, res) => {
    await user(req);
    res.json(
      await store.listBundles(int(req.params.id, 'id'), {
        search:
          typeof req.query.search === 'string' ? req.query.search : undefined,
        limit: Math.min(200, Number(req.query.limit) || 50),
      }),
    );
  });

  router.get('/bundles/:id', async (req, res) => {
    await user(req);
    const id = int(req.params.id, 'id');
    const bundle = await store.getBundle(id);
    if (!bundle) throw new NotFoundError(`No bundle ${id}`);
    res.json({ bundle, batches: await store.listBatches(id) });
  });

  router.get('/batches/:id', async (req, res) => {
    await user(req);
    const batch = await store.getBatch(int(req.params.id, 'id'));
    if (!batch) throw new NotFoundError('No such batch');
    res.json(batch);
  });

  router.get('/builds', async (req, res) => {
    await user(req);
    res.json(
      await store.listBuilds({
        projectId: req.query.projectId
          ? int(req.query.projectId, 'projectId')
          : undefined,
        states:
          typeof req.query.state === 'string'
            ? (req.query.state.split(',') as any)
            : undefined,
        limit: Math.min(200, Number(req.query.limit) || 50),
      }),
    );
  });

  router.get('/builds/:id', async (req, res) => {
    await user(req);
    const build = await store.getBuild(int(req.params.id, 'id'));
    if (!build) throw new NotFoundError('No such build');
    res.json(build);
  });

  router.get('/builds/:id/logs', async (req, res) => {
    await user(req);
    const levels =
      typeof req.query.levels === 'string'
        ? (req.query.levels
            .split(',')
            .filter(l => LEVELS.includes(l as LogLevel)) as LogLevel[])
        : undefined;
    res.json(
      await store.getLogs(int(req.params.id, 'id'), {
        after: Number(req.query.after) || 0,
        limit: Math.min(5000, Number(req.query.limit) || 1000),
        levels,
      }),
    );
  });

  router.get('/stats', async (req, res) => {
    await user(req);
    res.json(await store.stats());
  });

  router.get('/hosts', async (req, res) => {
    await user(req);
    res.json(await store.listHosts());
  });

  // ------------------------------------------------------------ configuring
  router.post('/projects', async (req, res) => {
    await authorize(req, runbotConfigurePermission);
    const body = req.body as CreateProjectRequest;
    const name = str(body.name, 'name', /^[\w .-]{1,60}$/);
    const baseBranches = Array.isArray(body.baseBranches)
      ? body.baseBranches.map(b => str(b, 'base branch', BRANCH))
      : [];
    if (!baseBranches.length)
      throw new InputError('At least one base branch, e.g. 19.0');
    const masterBase = str(
      body.masterBase ?? baseBranches[0],
      'masterBase',
      BRANCH,
    );
    if (!baseBranches.includes(masterBase))
      throw new InputError('masterBase must be one of the base branches');
    const batchDelay = Number.isInteger(body.batchDelay)
      ? Math.min(3600, Math.max(0, body.batchDelay!))
      : 60;
    res.status(201).json(
      await store.createProject({
        name,
        baseBranches,
        masterBase,
        batchDelay,
      }),
    );
  });

  router.post('/repos', async (req, res) => {
    await authorize(req, runbotConfigurePermission);
    const body = req.body as AddRepoRequest;
    const projectId = int(body.projectId, 'projectId');
    const project = await store.getProject(projectId);
    if (!project) throw new NotFoundError(`No project ${projectId}`);
    const slug = str(body.slug, 'slug', SLUG);
    const existing = (await store.listRepos(projectId)).find(
      r => r.slug.toLowerCase() === slug.toLowerCase(),
    );
    if (existing) throw new InputError(`${slug} is already in ${project.name}`);
    // Check the token can read it before anything is stored
    let defaultBranch: string;
    try {
      defaultBranch = (await github.getRepo(slug)).defaultBranch;
    } catch (e) {
      throw new InputError(
        `GitHub can't find ${slug} with Backstage's token (a private repository needs a token with the repo scope): ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    const isServer = Boolean(body.isServer);
    const servers = (await store.listRepos(projectId)).filter(r => r.isServer);
    if (body.createTrigger && !isServer && !servers.length) {
      throw new InputError(
        'Add odoo/odoo to the project first: a trigger needs a repository with odoo-bin',
      );
    }
    const repo = await store.createRepo({
      projectId,
      slug,
      name: (body.name?.trim() || slug.split('/')[1]).slice(0, 80),
      isServer,
      defaultBranch,
      addonsSubdir:
        typeof body.addonsSubdir === 'string'
          ? body.addonsSubdir.replace(/^\/+|\/+$/g, '').replace(/\.\./g, '')
          : '',
      entityRef:
        typeof body.entityRef === 'string' ? body.entityRef : undefined,
    });
    let trigger;
    if (body.createTrigger && !isServer) {
      trigger = await store.createTrigger({
        projectId,
        name: repo.name,
        repoIds: [repo.id],
        dependencyRepoIds: servers.map(s => s.id),
        steps: [defaultInstallTestStep()],
        ciContext: ciContextFor(repo.name),
        baseOnly: false,
        active: true,
        sequence: 10,
      });
    }
    // First poll right away, so the page fills in without waiting a minute
    leader.pollRepo(repo).then(
      () => store.setRepoPolled(repo.id),
      e =>
        store.setRepoPolled(
          repo.id,
          e instanceof Error ? e.message : String(e),
        ),
    );
    res.status(201).json({ repo, trigger });
  });

  router.patch('/repos/:id', async (req, res) => {
    await authorize(req, runbotConfigurePermission);
    const id = int(req.params.id, 'id');
    if (typeof req.body?.active !== 'boolean')
      throw new InputError('active (true/false) is required');
    await store.setRepoActive(id, req.body.active);
    res.json(await store.getRepo(id));
  });

  router.post('/triggers', async (req, res) => {
    await authorize(req, runbotConfigurePermission);
    const body = req.body as CreateTriggerRequest;
    const projectId = int(body.projectId, 'projectId');
    const repos = await store.listRepos(projectId);
    const ids = (v: unknown, name: string) => {
      const list = Array.isArray(v) ? v.map(x => int(x, name)) : [];
      const unknown = list.filter(i => !repos.some(r => r.id === i));
      if (unknown.length)
        throw new InputError(
          `${name}: not repositories of this project: ${unknown.join(', ')}`,
        );
      return list;
    };
    const repoIds = ids(body.repoIds, 'repoIds');
    if (!repoIds.length)
      throw new InputError('repoIds: at least one repository to test');
    const name = str(body.name, 'name', /^[\w .-]{1,60}$/);
    res.status(201).json(
      await store.createTrigger({
        projectId,
        name,
        repoIds,
        dependencyRepoIds: ids(body.dependencyRepoIds, 'dependencyRepoIds'),
        steps: parseSteps(body.steps),
        ciContext: body.ciContext?.trim() || ciContextFor(name),
        baseOnly: Boolean(body.baseOnly),
        active: true,
        sequence: 10,
      }),
    );
  });

  router.patch('/triggers/:id', async (req, res) => {
    await authorize(req, runbotConfigurePermission);
    const b = req.body ?? {};
    const updated = await store.updateTrigger(int(req.params.id, 'id'), {
      ...(b.steps !== undefined ? { steps: parseSteps(b.steps) } : {}),
      ...(typeof b.active === 'boolean' ? { active: b.active } : {}),
      ...(typeof b.baseOnly === 'boolean' ? { baseOnly: b.baseOnly } : {}),
    });
    if (!updated) throw new NotFoundError('No such trigger');
    res.json(updated);
  });

  // ---------------------------------------------------------- build actions
  router.post('/bundles/:id/force', async (req, res) => {
    await authorize(req, runbotBuildManagePermission);
    const id = int(req.params.id, 'id');
    const bundle = await store.getBundle(id);
    if (!bundle) throw new NotFoundError('No such bundle');
    // Backdated so it's prepared at the next pass instead of after the delay
    const batchId = await store.requestBatch(id, new Date(0).toISOString());
    res.status(202).json({ batchId });
  });

  router.post('/builds/:id/rebuild', async (req, res) => {
    await authorize(req, runbotBuildManagePermission);
    const old = await store.getBuild(int(req.params.id, 'id'));
    if (!old) throw new NotFoundError('No such build');
    const id = await store.createBuild({
      projectId: old.projectId,
      triggerId: old.triggerId,
      paramsHash: old.paramsHash,
      params: old.params,
    });
    await store.replaceInSlots(old.id, id);
    await statuses.report(id);
    res.status(201).json({ buildId: id });
  });

  router.post('/builds/:id/kill', async (req, res) => {
    const credentials = await authorize(req, runbotBuildManagePermission);
    const id = int(req.params.id, 'id');
    if (!(await store.requestKill(id)))
      throw new NotFoundError('No such build');
    logger.info(
      `runbot: kill of build ${id} requested by ${
        (credentials.principal as any).userEntityRef
      }`,
    );
    await statuses.report(id);
    res.status(202).json({ buildId: id });
  });

  // ---------------------------------------------------------------- builders
  router.post('/builder/heartbeat', async (req, res) => {
    await builder(req);
    const name = str(req.body?.host, 'host', /^[\w.-]{1,100}$/);
    const running = Array.isArray(req.body?.running)
      ? req.body.running.map(Number).filter(Number.isInteger)
      : [];
    await store.heartbeat({
      name,
      workers: Math.max(0, Number(req.body?.workers) || 0),
      running,
      version: String(req.body?.version ?? '').slice(0, 40),
    });
    res.json({ kill: await store.killRequestedFor(name) });
  });

  router.post('/builder/claim', async (req, res) => {
    await builder(req);
    const host = str(req.body?.host, 'host', /^[\w.-]{1,100}$/);
    const build = await store.claimBuild(host);
    if (!build) {
      res.status(204).end();
      return;
    }
    await statuses.report(build.id);
    res.json({
      buildId: build.id,
      params: build.params,
      dbName: buildDbName(build.id),
    });
  });

  router.post('/builder/builds/:id/logs', async (req, res) => {
    await builder(req);
    const lines = Array.isArray(req.body?.lines)
      ? req.body.lines.slice(0, 5000)
      : [];
    await store.appendLogs(
      int(req.params.id, 'id'),
      lines.map((l: any) => ({
        level: LEVELS.includes(l?.level) ? l.level : 'INFO',
        logger: String(l?.logger ?? 'runbot'),
        message: String(l?.message ?? ''),
        created: typeof l?.created === 'string' ? l.created : undefined,
      })),
    );
    res.status(204).end();
  });

  router.post('/builder/builds/:id/result', async (req, res) => {
    await builder(req);
    const id = int(req.params.id, 'id');
    const result = req.body?.result;
    if (!['ok', 'warn', 'ko', 'killed'].includes(result))
      throw new InputError('result must be ok, warn, ko or killed');
    await store.finishBuild(
      id,
      result,
      typeof req.body?.errorSummary === 'string'
        ? req.body.errorSummary
        : undefined,
    );
    await statuses.report(id);
    res.status(204).end();
  });

  return router;
}
