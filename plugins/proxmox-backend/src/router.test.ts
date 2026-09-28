import express from 'express';
import { AddressInfo } from 'node:net';
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
  get: jest.fn(async (path: string) => {
    if (path === 'cluster/resources')
      return { status: 200, body: { data: raw } };
    return { status: 200, body: { data: [] } };
  }),
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
    await createRouter({ logger, httpAuth, client, cacheSeconds: 60 } as any),
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(err.name === 'AuthenticationError' ? 401 : 500)
        .json({ error: err.message });
    },
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => jest.clearAllMocks());

it('rejects anonymous callers', async () => {
  const res = await fetch(`${base}/resources`);
  expect(res.status).toBe(401);
});

it('returns aggregated resources for a signed-in user', async () => {
  const res = await fetch(`${base}/resources`, auth);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.nodes).toHaveLength(1);
  expect(body.guests).toHaveLength(1);
  expect(body.storage[0].storage).toBe('uc3200');
});

it('caches so a second call does not re-hit Proxmox', async () => {
  await fetch(`${base}/resources`, auth);
  await fetch(`${base}/resources`, auth);
  // only one underlying /cluster/resources fetch across both (plus cluster/status)
  const calls = client.get.mock.calls.filter(c => c[0] === 'cluster/resources');
  expect(calls.length).toBeLessThanOrEqual(1);
});

it('computes attention items', async () => {
  const res = await fetch(`${base}/attention`, auth);
  const body = await res.json();
  const cats = body.items.map((i: any) => i.category);
  expect(cats).toEqual(
    expect.arrayContaining(['guestStopped', 'storageFull', 'nodeMemoryHigh']),
  );
});

it('reports configured=false when no client', async () => {
  const app = express();
  app.use(await createRouter({ logger, httpAuth } as any));
  const s = app.listen(0);
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const res = await fetch(`${b}/health`, auth);
  expect((await res.json()).configured).toBe(false);
  s.close();
});
