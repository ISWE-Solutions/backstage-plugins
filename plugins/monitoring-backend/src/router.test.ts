import express from 'express';
import { AddressInfo } from 'node:net';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';
import { createSettingsStore } from './store';
import { testDatabase } from './__testUtils__/testDatabase';
import { validate } from './settings';

async function serve(allow: boolean) {
  const store = await createSettingsStore(testDatabase());
  const router = await createRouter({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn(),
    } as any,
    httpAuth: {
      credentials: jest.fn(async () => ({
        principal: { type: 'user', userEntityRef: 'user:default/admin' },
      })),
    } as any,
    permissions: {
      authorize: jest.fn(async () => [
        { result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY },
      ]),
    } as any,
    store,
  });
  const app = express();
  app.use(router);
  // the backend's error handler, reduced: Backstage maps these error names to HTTP statuses
  app.use((err: any, _req: any, res: any, _next: any) =>
    res
      .status(
        { NotAllowedError: 403, InputError: 400 }[err.name as string] ?? 500,
      )
      .json({ error: err.message }),
  );
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => server.close() };
}

const put = (url: string, changes: unknown) =>
  fetch(`${url}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });

describe('settings router', () => {
  it('lets an admin save and remove settings', async () => {
    const s = await serve(true);
    try {
      let body = await (await fetch(`${s.url}/settings`)).json();
      expect(body).toMatchObject({ settings: {}, canEdit: true });
      expect(body.keys).toContain('costs.electricity.tariffPerKwh');
      const res = await put(s.url, {
        'costs.electricity.tariffPerKwh': 2.94,
        'costs.currency': 'ZMW',
      });
      expect(res.status).toBe(200);
      body = await res.json();
      expect(body.settings['costs.electricity.tariffPerKwh']).toMatchObject({
        value: 2.94,
        updatedBy: 'user:default/admin',
      });
      body = await (await put(s.url, { 'costs.currency': null })).json();
      expect(body.settings['costs.currency']).toBeUndefined();
    } finally {
      s.close();
    }
  });

  it('refuses changes without the permission, but still shows the settings', async () => {
    const s = await serve(false);
    try {
      expect((await (await fetch(`${s.url}/settings`)).json()).canEdit).toBe(
        false,
      );
      expect((await put(s.url, { 'costs.currency': 'ZMW' })).status).toBe(403);
    } finally {
      s.close();
    }
  });

  it('refuses bad values', async () => {
    const s = await serve(true);
    try {
      const res = await put(s.url, {
        'costs.electricity.pue': 7,
        'costs.currency': 'kwacha',
        'costs.nope': 1,
      });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error).toMatch(/pue: between 1 and 3/);
      expect(error).toMatch(/currency: a three-letter/);
      expect(error).toMatch(/costs.nope: not a setting/);
    } finally {
      s.close();
    }
  });
});

describe('validate', () => {
  it('accepts numbers in range, currency codes and removals', () => {
    expect(
      validate({
        'costs.split.cpu': 0.4,
        'costs.currency': 'USD',
        'costs.rates.networkGb': null,
      }),
    ).toEqual([]);
    expect(validate({ 'costs.split.cpu': 1.5 })).toEqual([
      'costs.split.cpu: between 0 and 1',
    ]);
    expect(validate({ 'costs.rates.networkGb': -1 })).toEqual([
      'costs.rates.networkGb: 0 or more',
    ]);
    expect(validate([])).toHaveLength(1);
  });
});
