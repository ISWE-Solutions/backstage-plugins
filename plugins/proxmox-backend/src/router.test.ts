import express from 'express';
import { AddressInfo } from 'node:net';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';

const raw = [
  {
    type: 'node',
    node: 'pve10',
    status: 'online',
    cpu: 0.1,
    maxcpu: 8,
    mem: 15e9,
    maxmem: 16e9,
    uptime: 1000,
  },
  {
    type: 'lxc',
    id: 'lxc/190',
    vmid: 190,
    name: 'ento',
    node: 'pve10',
    status: 'stopped',
    maxmem: 2e9,
    template: '0',
  },
  {
    type: 'storage',
    storage: 'uc3200',
    node: 'pve10',
    used: 9.6e9,
    total: 1e10,
    status: 'available',
  },
];

const client = {
  get: jest.fn(async (path: string) =>
    path === 'cluster/resources'
      ? { status: 200, body: { data: raw } }
      : { status: 200, body: { data: [] } },
  ),
};

const registry = {
  list: jest.fn(async () => [
    {
      id: 'config:default',
      name: 'DC1',
      url: 'https://x',
      verifyTls: false,
      source: 'config',
      hasToken: true,
      uiUrls: {},
    },
  ]),
  resolve: jest.fn(async (id: string) =>
    id === 'config:default'
      ? {
          id,
          name: 'DC1',
          url: 'https://x',
          token: 't',
          verifyTls: false,
          uiUrls: {},
          source: 'config',
        }
      : undefined,
  ),
  clientFor: jest.fn(async (id: string) =>
    id === 'config:default'
      ? {
          client,
          cluster: {
            id,
            name: 'DC1',
            url: 'https://x',
            token: 't',
            verifyTls: false,
            uiUrls: {},
            source: 'config',
          },
        }
      : undefined,
  ),
  defaultId: jest.fn(async () => 'config:default'),
  add: jest.fn(async () => ({
    id: 'db1',
    name: 'new',
    url: 'https://y',
    verifyTls: false,
    source: 'db',
    hasToken: true,
    uiUrls: {},
  })),
  update: jest.fn(),
  remove: jest.fn(),
};

const httpAuth = {
  credentials: jest.fn(async (req: express.Request) => {
    if (!req.headers.authorization) {
      throw Object.assign(new Error('no credentials'), {
        name: 'AuthenticationError',
      });
    }
    return {
      principal: { type: 'user', userEntityRef: 'user:default/tester' },
    };
  }),
};
let allow = true;
const permissions = {
  authorize: jest.fn(async () => [
    { result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY },
  ]),
};
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
};

let base = '';
let server: ReturnType<express.Express['listen']>;
const auth = { headers: { authorization: 'Bearer t' } };

beforeAll(async () => {
  const app = express();
  app.use(
    await createRouter({
      logger,
      httpAuth,
      permissions,
      registry,
      cacheSeconds: 60,
    } as any),
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(
          err.name === 'AuthenticationError'
            ? 401
            : err.name === 'NotAllowedError'
            ? 403
            : 500,
        )
        .json({ error: err.message });
    },
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  jest.clearAllMocks();
  allow = true;
});

it('rejects anonymous callers', async () => {
  expect((await fetch(`${base}/resources`)).status).toBe(401);
});

it('lists clusters', async () => {
  const body = await (await fetch(`${base}/clusters`, auth)).json();
  expect(body.clusters[0].name).toBe('DC1');
  expect(body.clusters[0]).not.toHaveProperty('token');
});

it('returns resources for the default cluster tagged with its id/name', async () => {
  const body = await (await fetch(`${base}/resources`, auth)).json();
  expect(body.nodes).toHaveLength(1);
  expect(body.clusterName).toBe('DC1');
});

it('computes attention items', async () => {
  const body = await (await fetch(`${base}/attention`, auth)).json();
  const cats = body.items.map((i: any) => i.category);
  expect(cats).toEqual(
    expect.arrayContaining(['guestStopped', 'storageFull', 'nodeMemoryHigh']),
  );
});

it('403s cluster creation without the manage permission', async () => {
  allow = false;
  const res = await fetch(`${base}/clusters`, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'n', url: 'https://y', token: 't' }),
  });
  expect(res.status).toBe(403);
});

it('creates a cluster with the manage permission', async () => {
  const res = await fetch(`${base}/clusters`, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'n', url: 'https://y', token: 't' }),
  });
  expect(res.status).toBe(201);
  expect(registry.add).toHaveBeenCalled();
});
