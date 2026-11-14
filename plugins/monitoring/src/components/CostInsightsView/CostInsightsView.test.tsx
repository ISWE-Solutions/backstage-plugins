import { screen } from '@testing-library/react';
import {
  MockConfigApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import {
  configApiRef,
  discoveryApiRef,
  FetchApi,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { CostInsightsView } from './CostInsightsView';

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const GIB = 1024 ** 3;
// canned answers by a fragment of each query (the first match wins)
const answers: [string, { metric: Record<string, string>; value: number }[]][] =
  [
    [
      'pve_guest_info[10m]',
      [
        {
          metric: {
            vmid: '101',
            name: 'app',
            node: 'pve01',
            kind: 'ct',
            env: 'prod',
            tags: 'prod',
          },
          value: 1,
        },
      ],
    ],
    [
      'pve_guest_info[',
      [
        {
          metric: {
            vmid: '101',
            name: 'app',
            node: 'pve01',
            kind: 'ct',
            env: 'prod',
            tags: 'prod',
          },
          value: 1,
        },
      ],
    ],
    ['count(pve_guest_cpu_cores)', [{ metric: {}, value: 288 }]],
    ['count_over_time', [{ metric: { vmid: '101' }, value: 288 }]],
    ['pve_guest_cpu_used_cores', [{ metric: { vmid: '101' }, value: 288 }]],
    [
      'pve_guest_memory_used_bytes',
      [{ metric: { vmid: '101' }, value: 2 * GIB * 288 }],
    ],
    ['and on (vmid)', [{ metric: { vmid: '101' }, value: 8 * GIB * 288 }]],
    ['sum_over_time', [{ metric: { vmid: '101' }, value: 4 * 288 }]],
    [
      'pve_guest_disk_max_bytes',
      [{ metric: { vmid: '101' }, value: 50 * GIB }],
    ],
    ['pve_guest_net_', [{ metric: { vmid: '101' }, value: 3 * GIB }]],
    ['pve_node_cpu_cores', [{ metric: {}, value: 96 }]],
    ['pve_node_memory_total_bytes', [{ metric: {}, value: 200 * GIB }]],
    ['pve_storage_size_bytes', [{ metric: {}, value: 4000 * GIB }]],
    ['pve_pbs_total_bytes', [{ metric: {}, value: 3000 * GIB }]],
    [
      'pve_guest_memory_max_bytes',
      [{ metric: { vmid: '101' }, value: 8 * GIB }],
    ],
    ['pve_guest_cpu_cores', [{ metric: { vmid: '101' }, value: 4 }]],
  ];

const fetchApi = {
  fetch: jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const query = decodeURIComponent(url.split('query=')[1]);
    const hit = answers.find(([k]) => query.includes(k));
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          result: (hit?.[1] ?? []).map(r => ({
            metric: r.metric,
            value: [0, String(r.value)],
          })),
        },
      }),
    };
  }),
};

const render = (costs: object) =>
  renderInTestApp(
    <TestApiProvider
      apis={[
        [configApiRef, new MockConfigApi({ monitoring: { costs } })],
        [
          discoveryApiRef,
          { getBaseUrl: async () => 'http://backstage/api/proxy' },
        ],
        [fetchApiRef, fetchApi as unknown as FetchApi],
        [catalogApiRef, { getEntities: async () => ({ items: [] }) }],
      ]}
    >
      <CostInsightsView />
    </TestApiProvider>,
  );

describe('CostInsightsView', () => {
  it('shows guests and their cost, with a warning for example rates', async () => {
    await render({});
    expect(await screen.findByText('Per guest')).toBeInTheDocument();
    expect(screen.getAllByText('app').length).toBeGreaterThan(0);
    expect(screen.getByText(/example rates/)).toBeInTheDocument();
    expect(screen.getByText('How costs are calculated')).toBeInTheDocument();
  });

  it('shows unused capacity when the monthly cost is configured', async () => {
    await render({ currency: 'ZMW', monthlyInfrastructureCost: 50000 });
    expect(
      await screen.findByText('Unused capacity, per month'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/example rates/)).not.toBeInTheDocument();
  });
});
