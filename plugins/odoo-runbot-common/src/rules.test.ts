import {
  baseFor,
  batchCommits,
  buildDbName,
  buildResult,
  bundleNameForPr,
  canonicalJson,
  classify,
  decideTrigger,
  defaultInstallTestStep,
  parseOdooLogLine,
  selectModules,
  versionOf,
  ciContextFor,
  RunbotRepo,
  RunbotTrigger,
} from './index';

const project = { baseBranches: ['19.0', '18.0'], masterBase: '19.0' };

const repo = (id: number, name: string, isServer = false): RunbotRepo => ({
  id,
  projectId: 1,
  name,
  slug: `org/${name}`,
  isServer,
  addonsSubdir: '',
  defaultBranch: 'main',
  active: true,
  created: '',
});
const repos = [
  repo(1, 'odoo', true),
  repo(2, 'iswe_meal_addons'),
  repo(3, 'iswe_sdp_addons'),
];

const trigger = (patch: Partial<RunbotTrigger> = {}): RunbotTrigger => ({
  id: 10,
  projectId: 1,
  name: 'meal',
  repoIds: [2],
  dependencyRepoIds: [1],
  steps: [defaultInstallTestStep()],
  ciContext: 'ci/runbot-meal',
  executor: 'docker',
  baseOnly: false,
  active: true,
  sequence: 1,
  ...patch,
});

describe('bundles', () => {
  it('resolves base bundles like runbot', () => {
    expect(baseFor(project, '19.0')).toBe('19.0');
    expect(baseFor(project, '18.0-fix-taxes')).toBe('18.0');
    expect(baseFor(project, 'main')).toBe('19.0');
    expect(baseFor(project, 'feature-x')).toBe('19.0');
    expect(versionOf('saas-18.4')).toBe('18.4');
    expect(bundleNameForPr('someone:fix-x')).toBe('fix-x');
  });

  it('takes the bundle head, else the base head', () => {
    const commits = batchCommits(
      repos,
      new Map([[2, 'aaa']]),
      new Map([
        [1, 'odoo19'],
        [2, 'mainsha'],
      ]),
    );
    expect(commits.map(c => [c.repoName, c.sha, c.match])).toEqual([
      ['odoo', 'odoo19', 'base'],
      ['iswe_meal_addons', 'aaa', 'head'],
    ]);
  });
});

describe('decideTrigger', () => {
  const commits = batchCommits(
    repos,
    new Map([[2, 'aaa']]),
    new Map([
      [1, 'odoo19'],
      [3, 'sdp'],
    ]),
  );

  it('builds the tested repo with odoo', () => {
    const d = decideTrigger(trigger(), repos, commits, {
      isBase: false,
      version: '19.0',
    });
    expect(d.run).toBe(true);
    const params = (d as Extract<typeof d, { run: true }>).params;
    expect(params.commits.map(c => [c.repoName, c.tested, c.isServer])).toEqual(
      [
        ['odoo', false, true],
        ['iswe_meal_addons', true, false],
      ],
    );
  });

  it('skips a dev bundle without a branch of the tested repo', () => {
    const d = decideTrigger(trigger({ repoIds: [3] }), repos, commits, {
      isBase: false,
      version: '19.0',
    });
    expect(d).toEqual({
      run: false,
      reason: 'No branch of the tested repositories in this bundle',
    });
  });

  it('needs every repo and a server, and honours base-only', () => {
    const noOdoo = commits.filter(c => c.repoId !== 1);
    expect(
      decideTrigger(trigger(), repos, noOdoo, {
        isBase: false,
        version: '19.0',
      }),
    ).toMatchObject({ run: false });
    expect(
      decideTrigger(trigger({ dependencyRepoIds: [] }), repos, commits, {
        isBase: false,
        version: '19.0',
      }),
    ).toMatchObject({
      run: false,
      reason: expect.stringContaining('odoo-bin'),
    });
    expect(
      decideTrigger(trigger({ baseOnly: true }), repos, commits, {
        isBase: false,
        version: '19.0',
      }),
    ).toMatchObject({
      run: false,
    });
  });

  it('hashes params canonically', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
  });
});

describe('logs and results', () => {
  it('parses Odoo log lines', () => {
    expect(
      parseOdooLogLine(
        '2026-10-27 10:15:02,123 4567 ERROR runbot_12_all odoo.addons.meal.tests.test_x: FAIL: test_budget',
      ),
    ).toEqual({
      level: 'ERROR',
      logger: 'odoo.addons.meal.tests.test_x',
      message: 'FAIL: test_budget',
    });
    expect(
      parseOdooLogLine('Traceback (most recent call last):'),
    ).toBeUndefined();
  });

  it('classifies and decides results', () => {
    expect(
      classify({
        level: 'WARNING',
        logger: 'x',
        message: 'Test test_x took 3.2s to run',
      }),
    ).toBeUndefined();
    expect(
      classify({
        level: 'WARNING',
        logger: 'x',
        message: 'Field foo has no string',
      }),
    ).toBe('warning');
    const base = {
      exitCode: 0,
      timedOut: false,
      killed: false,
      errors: 0,
      warnings: 0,
    };
    expect(buildResult(base)).toBe('ok');
    expect(buildResult({ ...base, warnings: 2 })).toBe('warn');
    expect(buildResult({ ...base, errors: 1 })).toBe('ko');
    expect(buildResult({ ...base, exitCode: 1 })).toBe('ko');
    expect(buildResult({ ...base, timedOut: true })).toBe('ko');
    expect(buildResult({ ...base, killed: true, errors: 3 })).toBe('killed');
  });

  it('selects modules and names databases', () => {
    expect(
      selectModules(['meal', 'meal_ai', 'iswe_o19_theme'], ['meal*'], ['*_ai']),
    ).toEqual(['meal']);
    expect(selectModules(['b', 'a'], [], [])).toEqual(['a', 'b']);
    expect(buildDbName(42)).toBe('runbot_42_all');
    expect(ciContextFor('MEAL addons')).toBe('ci/runbot-meal-addons');
  });
});
