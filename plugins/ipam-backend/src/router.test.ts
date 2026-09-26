import express from 'express';
import { AddressInfo } from 'node:net';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';

const phpipam = { request: jest.fn() };
const permissions = { authorize: jest.fn(), authorizeConditional: jest.fn() };
const httpAuth = {
  credentials: jest.fn(async (req: express.Request) => {
    if (!req.headers.authorization) {
      throw Object.assign(new Error('no credentials'), {
        name: 'AuthenticationError',
      });
    }
    if (req.headers['x-test-service']) {
      return { principal: { type: 'service', subject: 'plugin:dhis2' } };
    }
    return {
      principal: { type: 'user', userEntityRef: 'user:default/tester' },
    };
  }),
  issueUserCookie: jest.fn(),
};
const allocations = {
  allocate: jest.fn(),
  confirm: jest.fn(),
  release: jest.fn(),
  pool: { from: 'a', to: 'b' },
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

beforeAll(async () => {
  const app = express();
  app.use(
    await createRouter({
      logger,
      httpAuth,
      permissions,
      phpipam,
      allocations,
    } as any),
  );
  // stand-in for the backend's error middleware
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err.name === 'NotAllowedError'
          ? 403
          : err.name === 'AuthenticationError'
          ? 401
          : 500;
      res.status(status).json({ error: err.message });
    },
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => jest.clearAllMocks());

const call = (
  method: string,
  path: string,
  body?: unknown,
  auth = true,
  service = false,
) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: 'Bearer x' } : {}),
      ...(service ? { 'x-test-service': '1' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('ipam backend router', () => {
  it('forwards allowed reads, including sub-resources and query strings', async () => {
    phpipam.request.mockResolvedValue({
      status: 200,
      body: { success: true, data: [] },
    });
    const res = await call('GET', '/phpipam/subnets/7/usage/?x=1');
    expect(res.status).toBe(200);
    expect(phpipam.request).toHaveBeenCalledWith('GET', 'subnets/7/usage/?x=1');
  });

  it('refuses reads outside the allow-list without calling phpIPAM', async () => {
    const res = await call('GET', '/phpipam/user/');
    expect(res.status).toBe(404);
    expect(phpipam.request).not.toHaveBeenCalled();
  });

  it('refuses path traversal out of the allow-list', async () => {
    for (const path of [
      'subnets/../user/',
      'subnets/%2e%2e/user/',
      'vlan/7/../../tools/',
    ]) {
      const res = await call('GET', `/phpipam/${path}`);
      expect(res.status).not.toBe(200);
    }
    expect(phpipam.request).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    const res = await call('GET', '/phpipam/subnets/', undefined, false);
    expect(res.status).toBe(401);
  });

  it('refuses writes without the permission', async () => {
    permissions.authorize.mockResolvedValue([{ result: AuthorizeResult.DENY }]);
    const res = await call('POST', '/phpipam/addresses', {
      ip: '10.20.30.9',
      subnetId: '7',
    });
    expect(res.status).toBe(403);
    expect(phpipam.request).not.toHaveBeenCalled();
    expect(permissions.authorize.mock.calls[0][0][0].permission.name).toBe(
      'ipam.address.create',
    );
  });

  it('forwards permitted writes with only the allowed fields', async () => {
    permissions.authorize.mockResolvedValue([
      { result: AuthorizeResult.ALLOW },
    ]);
    phpipam.request.mockResolvedValue({ status: 201, body: { success: true } });
    const res = await call('POST', '/phpipam/subnets', {
      subnet: '10.60.0.0',
      mask: 24,
      sectionId: '3',
      description: 'x',
      isFolder: 1,
      permissions: 'x',
    });
    expect(res.status).toBe(201);
    expect(permissions.authorize.mock.calls[0][0][0].permission.name).toBe(
      'ipam.subnet.create',
    );
    expect(phpipam.request).toHaveBeenCalledWith('POST', 'subnets/', {
      subnet: '10.60.0.0',
      mask: 24,
      sectionId: '3',
      description: 'x',
    });
  });

  describe('allocations', () => {
    const body = {
      hostname: 'hmis-test',
      purpose: 'DHIS2 instance hmis-test',
      requestedBy: 'user:default/someone-else',
    };
    const allocated = {
      id: '9',
      ip: '10.20.30.150',
      prefix: 24,
      gateway: '10.20.30.1',
    };

    it('refuses users without ipam.address.create', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.DENY },
      ]);
      expect((await call('POST', '/allocations', body)).status).toBe(403);
      expect(allocations.allocate).not.toHaveBeenCalled();
    });

    it('lets a user allocate in their own name only', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      allocations.allocate.mockResolvedValue(allocated);
      const res = await call('POST', '/allocations', body);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ ip: '10.20.30.150' });
      expect(allocations.allocate).toHaveBeenCalledWith(
        expect.objectContaining({ requestedBy: 'user:default/tester' }),
      );
    });

    it('lets a backend plugin allocate on behalf of a user', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      allocations.allocate.mockResolvedValue(allocated);
      const res = await call('POST', '/allocations', body, true, true);
      expect(res.status).toBe(201);
      expect(allocations.allocate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedBy: 'user:default/someone-else via plugin:dhis2',
        }),
      );
    });

    it('validates input', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      const bad = await call('POST', '/allocations', {
        hostname: 'bad host!',
        purpose: 'x',
      });
      expect(bad.status).not.toBe(201);
      expect(allocations.allocate).not.toHaveBeenCalled();
    });

    it('confirms and releases', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      const confirmed = await call(
        'POST',
        '/allocations/9/confirm',
        { hostname: 'h' },
        true,
        true,
      );
      expect(confirmed.status).toBe(204);
      expect(allocations.confirm).toHaveBeenCalledWith('9', {
        hostname: 'h',
        description: undefined,
      });
      const released = await call(
        'DELETE',
        '/allocations/9',
        undefined,
        true,
        true,
      );
      expect(released.status).toBe(204);
      expect(allocations.release).toHaveBeenCalledWith('9');
    });
  });
});
