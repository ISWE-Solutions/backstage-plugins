import { loadLiveServiceHealth } from './liveHealth';

const component = (name: string, annotations: Record<string, string>) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, namespace: 'default', annotations },
  spec: { system: 'shared-services' },
});

// one canned Prometheus result per query, matched by a fragment of the query
const results: [string, { metric: Record<string, string>; value: string }[]][] =
  [
    [
      'avg_over_time',
      [
        { metric: { http_url: 'https://a.example.org/' }, value: '100' },
        { metric: { http_url: 'https://b.example.org/' }, value: '97.5' },
      ],
    ],
    [
      'httpcheck_status',
      [
        { metric: { http_url: 'https://a.example.org/' }, value: '1' },
        { metric: { http_url: 'https://b.example.org/' }, value: '1' },
        { metric: { http_url: 'https://c.example.org/' }, value: '0' },
      ],
    ],
    [
      'httpcheck_duration',
      [{ metric: { http_url: 'https://a.example.org/' }, value: '120' }],
    ],
    [
      'tlscheck',
      [{ metric: { tlscheck_x509_cn: 'a.example.org' }, value: '60.4' }],
    ],
    [
      'cpu_ratio',
      [
        { metric: { name: 'a1' }, value: '10' },
        { metric: { name: 'a2' }, value: '30' },
      ],
    ],
    ['memory_used', [{ metric: { name: 'a1' }, value: '95' }]],
  ];

const apis = (entities: any[]) => {
  const fetch = jest.fn(async (url: string) => {
    const query = decodeURIComponent(url.split('query=')[1]);
    const hit = results.find(([k]) => query.includes(k));
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          result: (hit?.[1] ?? []).map(r => ({
            metric: r.metric,
            value: [0, r.value],
          })),
        },
      }),
    };
  });
  return {
    fetch,
    apis: {
      catalogApi: { getEntities: async () => ({ items: entities }) } as any,
      discoveryApi: { getBaseUrl: async () => 'http://backstage/api/proxy' },
      fetchApi: { fetch } as any,
      configApi: { getOptionalString: () => undefined } as any,
    },
  };
};

describe('loadLiveServiceHealth', () => {
  it('combines catalog annotations with Prometheus results', async () => {
    const { apis: a, fetch } = apis([
      component('a', {
        'iswesolutions.com/health-url': 'https://a.example.org/',
        'iswesolutions.com/proxmox-guests': 'a1, a2',
      }),
      component('b', {
        'iswesolutions.com/health-url': 'https://b.example.org/',
      }),
      component('c', {
        'iswesolutions.com/health-url': 'https://c.example.org/',
      }),
      component('d', {
        'iswesolutions.com/health-url': 'https://d.example.org/',
      }),
    ]);
    const health = await loadLiveServiceHealth(a);

    expect(fetch.mock.calls[0][0]).toMatch(
      /^http:\/\/backstage\/api\/proxy\/grafana\/api\/api\/datasources\/proxy\/uid\/prometheus\/api\/v1\/query\?query=/,
    );
    expect(health.map(h => [h.serviceName, h.status])).toEqual([
      ['c', 'down'],
      ['a', 'degraded'],
      ['b', 'degraded'],
      ['d', 'unknown'],
    ]);
    const svcA = health.find(h => h.serviceName === 'a')!;
    expect(svcA).toMatchObject({
      entityRef: 'component:default/a',
      system: 'shared-services',
      guests: ['a1', 'a2'],
      uptime24h: 100,
      responseTimeMs: 120,
      certDaysLeft: 60.4,
      cpuPercent: 30,
      memoryPercent: 95,
      reasons: ['Memory at 95%'],
    });
    expect(health.find(h => h.serviceName === 'b')!.reasons).toEqual([
      'Uptime 97.5% over 24 h',
    ]);
  });

  it('skips Prometheus when no component is annotated', async () => {
    const { apis: a, fetch } = apis([]);
    expect(await loadLiveServiceHealth(a)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
