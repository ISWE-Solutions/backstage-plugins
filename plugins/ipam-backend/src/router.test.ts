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
      return {
        principal: {
          type: 'service',
          subject: String(req.headers['x-test-subject'] ?? 'plugin:dhis2'),
        },
      };
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
const syncStatus = { record: jest.fn(), latest: jest.fn(async () => []) };
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
      syncStatus,
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

  describe('edit, delete and planning', () => {
    beforeEach(() => {
      phpipam.request.mockResolvedValue({
        status: 200,
        body: { success: true },
      });
    });

    it('updates only editable fields, never ip or subnet', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      const res = await call('PATCH', '/phpipam/addresses/12', {
        hostname: 'h2',
        ip: '10.0.0.1',
        subnetId: '9',
        note: 'n',
      });
      expect(res.status).toBe(200);
      expect(permissions.authorize.mock.calls[0][0][0].permission.name).toBe(
        'ipam.address.update',
      );
      expect(phpipam.request).toHaveBeenCalledWith('PATCH', 'addresses/12/', {
        hostname: 'h2',
        note: 'n',
      });
    });

    it('requires ipam.address.delete to delete, and a numeric id', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.DENY },
      ]);
      expect((await call('DELETE', '/phpipam/addresses/12')).status).toBe(403);
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      expect((await call('DELETE', '/phpipam/addresses/12')).status).toBe(200);
      expect(permissions.authorize.mock.calls[1][0][0].permission.name).toBe(
        'ipam.address.delete',
      );
      expect(
        (await call('DELETE', '/phpipam/addresses/..%2Fuser')).status,
      ).not.toBe(200);
    });

    it('splits subnets only into supported counts', async () => {
      permissions.authorize.mockResolvedValue([
        { result: AuthorizeResult.ALLOW },
      ]);
      expect(
        (await call('PATCH', '/phpipam/subnets/7/split', { number: 3 })).status,
      ).not.toBe(200);
      expect(
        (await call('PATCH', '/phpipam/subnets/7/split', { number: 4 })).status,
      ).toBe(200);
      expect(phpipam.request).toHaveBeenCalledWith(
        'PATCH',
        'subnets/7/split/',
        { number: 4 },
      );
    });

    it('serves public config with the allocation pool', async () => {
      const res = await call('GET', '/config');
      expect(await res.json()).toMatchObject({
        allocationPool: { from: 'a', to: 'b' },
      });
    });
  });

  describe('sync status', () => {
    const report = {
      finishedAt: '2026-09-26T10:00:00Z',
      sources: { proxmox: 96 },
    };
    const post = (subject?: string) =>
      fetch(`${base}/sync-status`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer x',
          'content-type': 'application/json',
          'x-test-service': '1',
          ...(subject ? { 'x-test-subject': subject } : {}),
        },
        body: JSON.stringify(report),
      });

    it('accepts reports only from the sync token', async () => {
      expect((await post('plugin:dhis2')).status).toBe(403);
      expect(syncStatus.record).not.toHaveBeenCalled();
      expect((await post('ipam-sync')).status).toBe(204);
      expect(syncStatus.record).toHaveBeenCalledWith(
        expect.objectContaining({ sources: { proxmox: 96 } }),
      );
    });

    it('refuses users posting reports', async () => {
      expect((await call('POST', '/sync-status', report)).status).not.toBe(204);
    });
  });
});
