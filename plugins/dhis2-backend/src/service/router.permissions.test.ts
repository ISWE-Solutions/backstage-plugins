import express from 'express';
import { AddressInfo } from 'node:net';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';

const permissions = { authorize: jest.fn(), authorizeConditional: jest.fn() };
const httpAuth = {
  credentials: jest.fn(async () => ({
    principal: { type: 'user', userEntityRef: 'user:default/tester' },
  })),
  issueUserCookie: jest.fn(),
};
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
};
const provisionService = new Proxy(
  {},
  {
    get: () =>
      jest.fn(() => {
        throw new Error('should not be reached');
      }),
  },
);
const instanceRegistryService = {
  listEnriched: jest.fn(async () => []),
  reconcile: jest.fn(async () => ({})),
};

const STATUS: Record<string, number> = {
  NotAllowedError: 403,
  InputError: 400,
};

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(
    await createRouter({
      logger,
      httpAuth,
      permissions,
      provisionService,
      databaseTransferService: {},
      instanceRegistryService,
    } as any),
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(STATUS[err.name] ?? 500).json({ error: err.message });
    },
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => jest.clearAllMocks());

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const asked = () =>
  permissions.authorize.mock.calls[0][0].map((r: any) => r.permission.name);

describe('DHIS2 route permissions', () => {
  it.each([
    ['/instances/provision', ['dhis2.instance.create']],
    ['/instances/dhis2-150/decommission', ['dhis2.instance.delete']],
    ['/instances/dhis2-150/clone', ['dhis2.instance.clone']],
    ['/instances/dhis2-150/upgrade', ['dhis2.instance.update']],
    ['/instances/dhis2-150/lifecycle', ['dhis2.instance.operate']],
    ['/instances/dhis2-150/restore', ['dhis2.instance.restore']],
    ['/instances/dhis2-150/proxy-files/write', ['dhis2.proxy.manage']],
    [
      '/databases/list',
      [
        'dhis2.instance.create',
        'dhis2.instance.clone',
        'dhis2.instance.restore',
      ],
    ],
  ])('refuses %s without %s', async (path, names) => {
    permissions.authorize.mockImplementation(async (reqs: any[]) =>
      reqs.map(() => ({ result: AuthorizeResult.DENY })),
    );
    const res = await post(path);
    expect(res.status).toBe(403);
    expect(asked()).toEqual(names);
  });

  it('lets a request through when any listed permission is allowed', async () => {
    // /restore/upload accepts create OR restore; allow only restore
    permissions.authorize.mockImplementation(async (reqs: any[]) =>
      reqs.map((r: any) => ({
        result:
          r.permission.name === 'dhis2.instance.restore'
            ? AuthorizeResult.ALLOW
            : AuthorizeResult.DENY,
      })),
    );
    const res = await post('/instances/dhis2-150/decommission');
    expect(res.status).toBe(403);
    permissions.authorize.mockClear();
    const upload = await fetch(`${base}/restore/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer x',
        'content-type': 'application/octet-stream',
      },
      body: 'x',
    });
    expect(upload.status).not.toBe(403);
  });

  it('does not check permissions for viewing the instance list', async () => {
    const res = await fetch(`${base}/instances`, {
      headers: { authorization: 'Bearer x' },
    });
    expect(res.status).toBe(200);
    expect(permissions.authorize).not.toHaveBeenCalled();
  });
});
