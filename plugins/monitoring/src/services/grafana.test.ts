import { ConfigReader } from '@backstage/config';
import { byFolder, grafanaUrl, loadGrafanaDashboards } from './grafana';

const hits = [
  {
    uid: 'a',
    title: 'Backups',
    url: '/d/a/backups',
    tags: ['platform'],
    folderTitle: 'Platform',
    type: 'dash-db',
  },
  {
    uid: 'b',
    title: 'VSDC: Fleet',
    url: '/d/b/vsdc-fleet',
    tags: ['vsdc'],
    folderTitle: 'VSDC',
    type: 'dash-db',
  },
  {
    uid: 'c',
    title: 'Network: Guests',
    url: '/d/c/net',
    tags: [],
    folderTitle: 'Network traffic',
    type: 'dash-db',
  },
  { uid: 'd', title: 'Home', url: '/d/d/home', type: 'dash-db' },
];

const config = (c: object) => new ConfigReader(c);

describe('grafana', () => {
  it('finds the Grafana address in the community plugin config', () => {
    expect(
      grafanaUrl(
        config({
          grafana: {
            hosts: [{ id: 'x', domain: 'https://g.example.org/' }],
            defaultHost: 'x',
          },
        }),
      ),
    ).toBe('https://g.example.org');
    expect(
      grafanaUrl(config({ grafana: { domain: 'https://old.example.org' } })),
    ).toBe('https://old.example.org');
    expect(
      grafanaUrl(
        config({
          monitoring: { grafanaUrl: 'https://own.example.org' },
          grafana: { domain: 'https://old.example.org' },
        }),
      ),
    ).toBe('https://own.example.org');
  });

  it('lists dashboards through the proxy with absolute links', async () => {
    const fetch = jest.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => hits,
    }));
    const list = await loadGrafanaDashboards({
      discoveryApi: { getBaseUrl: async () => 'http://backstage/api/proxy' },
      fetchApi: { fetch } as any,
      configApi: config({ grafana: { domain: 'https://g.example.org' } }),
    });
    expect(String(fetch.mock.calls[0][0])).toBe(
      'http://backstage/api/proxy/grafana/api/api/search?type=dash-db&limit=5000',
    );
    expect(list.find(d => d.uid === 'b')?.url).toBe(
      'https://g.example.org/d/b/vsdc-fleet',
    );
    expect(list.find(d => d.uid === 'd')?.folderTitle).toBe('General');
  });

  it('puts the configured folders first', async () => {
    const list = await loadGrafanaDashboards({
      discoveryApi: { getBaseUrl: async () => 'http://b/api/proxy' },
      fetchApi: {
        fetch: async () => ({ ok: true, json: async () => hits }),
      } as any,
      configApi: config({}),
    });
    expect(
      byFolder(list, ['VSDC', 'Network traffic']).map(g => g.folder),
    ).toEqual(['VSDC', 'Network traffic', 'General', 'Platform']);
  });

  it('reports an HTTP error', async () => {
    await expect(
      loadGrafanaDashboards({
        discoveryApi: { getBaseUrl: async () => 'http://b/api/proxy' },
        fetchApi: {
          fetch: async () => ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
          }),
        } as any,
        configApi: config({}),
      }),
    ).rejects.toThrow('HTTP 403');
  });
});
