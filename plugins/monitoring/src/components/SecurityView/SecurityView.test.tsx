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
import { SecurityView } from './SecurityView';

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const alert = (n: number, repo: string, fork: boolean) => ({
  number: n,
  html_url: `https://github.com/o/${repo}/security/dependabot/${n}`,
  created_at: '2026-10-01T00:00:00Z',
  dependency: {
    package: { ecosystem: 'npm', name: `pkg${n}` },
    manifest_path: 'package-lock.json',
  },
  security_advisory: { summary: `Advisory ${n}`, severity: 'high' },
  security_vulnerability: {
    severity: 'high',
    vulnerable_version_range: '< 2',
    first_patched_version: { identifier: '2.0.0' },
  },
  repository: { name: repo, full_name: `o/${repo}`, fork },
});

const fetchApi = {
  fetch: jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const forbidden = url.includes('code-scanning');
    return {
      ok: !forbidden,
      status: forbidden ? 403 : 200,
      statusText: '',
      headers: { get: () => null },
      json: async () =>
        forbidden
          ? { message: 'Must have admin rights' }
          : [alert(1, 'own-app', false), alert(2, 'posthog', true)],
    };
  }),
};

describe('SecurityView', () => {
  it('shows the organization alerts without forks, and why a source failed', async () => {
    await renderInTestApp(
      <TestApiProvider
        apis={[
          [configApiRef, new MockConfigApi({})],
          [discoveryApiRef, { getBaseUrl: async () => 'http://b/api/proxy' }],
          [fetchApiRef, fetchApi as unknown as FetchApi],
        ]}
      >
        <SecurityView />
      </TestApiProvider>,
    );
    expect(await screen.findByText('Advisory 1')).toBeInTheDocument();
    expect(screen.queryByText('Advisory 2')).not.toBeInTheDocument(); // in a fork
    expect(screen.getByText(/Include forks \(1 alerts\)/)).toBeInTheDocument();
    expect(screen.getByText(/security_events/)).toBeInTheDocument();
  });
});
