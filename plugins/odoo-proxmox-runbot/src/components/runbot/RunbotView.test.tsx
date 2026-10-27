import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { RunbotView } from './RunbotView';
import { runbotApiRef } from '../../api/runbotApi';

const sha = (c: string) => c.repeat(40);
const build = {
  id: 7,
  triggerId: 1,
  triggerName: 'iswe_meal_addons',
  localState: 'done',
  result: 'ko',
  requested: new Date().toISOString(),
  started: new Date().toISOString(),
  finished: new Date().toISOString(),
  host: 'runbot-1',
  errorSummary: 'FAIL: test_budget',
};
const api = {
  listProjects: jest.fn(async () => [
    {
      id: 1,
      name: 'ISWE Odoo 19',
      baseBranches: ['19.0'],
      masterBase: '19.0',
      batchDelay: 60,
      created: '',
    },
  ]),
  getProject: jest.fn(async () => ({
    project: {
      id: 1,
      name: 'ISWE Odoo 19',
      baseBranches: ['19.0'],
      masterBase: '19.0',
      batchDelay: 60,
      created: '',
    },
    repos: [
      {
        id: 1,
        projectId: 1,
        name: 'odoo',
        slug: 'odoo/odoo',
        isServer: true,
        addonsSubdir: '',
        defaultBranch: 'master',
        active: true,
        created: '',
      },
      {
        id: 2,
        projectId: 1,
        name: 'iswe_meal_addons',
        slug: 'ISWE-Solutions/iswe_meal_addons',
        isServer: false,
        addonsSubdir: '',
        defaultBranch: 'main',
        active: true,
        created: '',
      },
    ],
    triggers: [],
    stats: {
      pending: 1,
      testing: 0,
      ok: 3,
      warn: 0,
      ko: 1,
      killed: 0,
      skipped: 0,
    },
  })),
  listBundles: jest.fn(async () => [
    {
      id: 10,
      projectId: 1,
      name: '19.0',
      isBase: true,
      baseName: '19.0',
      version: '19.0',
      sticky: true,
      updated: '',
      branches: [
        {
          id: 1,
          repoId: 1,
          name: '19.0',
          headSha: sha('a'),
          bundleId: 10,
          isPr: false,
          alive: true,
          updated: '',
        },
        {
          id: 2,
          repoId: 2,
          name: 'main',
          headSha: sha('d'),
          bundleId: 10,
          isPr: false,
          alive: true,
          updated: '',
        },
      ],
      lastBatch: {
        id: 5,
        bundleId: 10,
        state: 'ready',
        created: new Date().toISOString(),
        commits: [
          {
            repoId: 1,
            repoName: 'odoo',
            slug: 'odoo/odoo',
            sha: sha('a'),
            match: 'head',
          },
          {
            repoId: 2,
            repoName: 'iswe_meal_addons',
            slug: 'ISWE-Solutions/iswe_meal_addons',
            sha: sha('d'),
            match: 'head',
          },
        ],
        slots: [
          { triggerId: 1, triggerName: 'iswe_meal_addons', buildId: 7, build },
        ],
      },
    },
  ]),
  listBuilds: jest.fn(async () => [build]),
  listHosts: jest.fn(async () => []),
  getBuild: jest.fn(async () => ({
    ...build,
    projectId: 1,
    paramsHash: 'x',
    killRequested: false,
    batchIds: [5],
    params: {
      version: '19.0',
      commits: [
        {
          repoId: 2,
          repoName: 'iswe_meal_addons',
          slug: 'ISWE-Solutions/iswe_meal_addons',
          sha: sha('d'),
          isServer: false,
          addonsSubdir: '',
          tested: true,
        },
      ],
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
    },
  })),
  getLogs: jest.fn(async () => [
    {
      id: 1,
      buildId: 7,
      level: 'ERROR',
      logger: 'odoo.addons.meal.tests',
      message: 'FAIL: test_budget',
      created: '',
    },
  ]),
};

describe('RunbotView', () => {
  it('shows bundles with their builds and opens a build with its log', async () => {
    await renderInTestApp(
      <TestApiProvider
        apis={[
          [runbotApiRef, api as any],
          [catalogApiRef, { getEntities: async () => ({ items: [] }) } as any],
        ]}
      >
        <RunbotView />
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('odoo:19.0')).toBeInTheDocument(),
    );
    expect(screen.getByText('iswe_meal_addons:main')).toBeInTheDocument();
    expect(screen.getByText(/1 ko/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('iswe_meal_addons')[0]);
    await waitFor(() =>
      expect(screen.getByText('Build #7')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByText('FAIL: test_budget').length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getByText('Rebuild')).toBeInTheDocument();
  });
});
