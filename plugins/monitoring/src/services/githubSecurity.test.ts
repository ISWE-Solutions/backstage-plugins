import { ConfigReader } from '@backstage/config';
import {
  fromCodeScanning,
  fromDependabot,
  loadSecurityAlerts,
  nextQuery,
} from './githubSecurity';

const dependabot = (n: number, fork = false) => ({
  number: n,
  html_url: `https://github.com/o/r/security/dependabot/${n}`,
  created_at: '2026-10-01T00:00:00Z',
  dependency: {
    package: { ecosystem: 'npm', name: 'vm2' },
    manifest_path: 'package-lock.json',
  },
  security_advisory: {
    ghsa_id: 'GHSA-x',
    cve_id: 'CVE-2023-1',
    summary: 'Sandbox escape',
    severity: 'critical',
    description: 'long',
  },
  security_vulnerability: {
    severity: 'critical',
    vulnerable_version_range: '< 3.9.18',
    first_patched_version: { identifier: '3.9.18' },
  },
  repository: {
    name: fork ? 'posthog' : 'app',
    full_name: `o/${fork ? 'posthog' : 'app'}`,
    fork,
    html_url: 'https://github.com/o/app',
  },
});
const codeScanning = {
  number: 7,
  html_url: 'https://github.com/o/app/security/code-scanning/7',
  created_at: '2026-11-01T00:00:00Z',
  rule: {
    id: 'js/sql-injection',
    severity: 'error',
    security_severity_level: null,
    description: 'SQL injection',
  },
  tool: { name: 'CodeQL' },
  most_recent_instance: {
    location: { path: 'src/db.js' },
    message: { text: 'query built from input' },
  },
  repository: { name: 'app', full_name: 'o/app', fork: false },
};

const response = (body: any, status = 200, link?: string) => ({
  ok: status < 400,
  status,
  statusText: '',
  headers: {
    get: (h: string) => (h.toLowerCase() === 'link' ? link ?? null : null),
  },
  json: async () => body,
});

const apis = (fetch: jest.Mock) => ({
  discoveryApi: { getBaseUrl: async () => 'http://b/api/proxy' },
  fetchApi: { fetch } as any,
  configApi: new ConfigReader({}),
});

describe('github security alerts', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads the next page from the Link header', () => {
    expect(
      nextQuery(
        '<https://api.github.com/organizations/1/dependabot/alerts?per_page=100&after=Y3Vy>; rel="next", <https://x?page=1>; rel="first"',
      ),
    ).toBe('?per_page=100&after=Y3Vy');
    expect(nextQuery('<https://x?page=1>; rel="prev"')).toBeUndefined();
    expect(nextQuery(null)).toBeUndefined();
  });

  it('maps both kinds of alert', () => {
    const d = fromDependabot(dependabot(1));
    expect(d).toMatchObject({
      severity: 'critical',
      packageName: 'vm2',
      ecosystem: 'npm',
      cve: 'CVE-2023-1',
      fixedVersion: '3.9.18',
      fork: false,
    });
    expect(d.description).toBe('');
    const c = fromCodeScanning(codeScanning);
    expect(c).toMatchObject({
      severity: 'high',
      source: 'code-scanning',
      packageName: 'js/sql-injection',
      ecosystem: 'CodeQL',
      location: 'src/db.js',
    });
  });

  it('follows pages through the proxy routes and keeps going when one source is refused', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('/code-scanning'))
        return response(
          { message: 'Resource not accessible by integration' },
          403,
        );
      if (url.includes('after=2')) return response([dependabot(3, true)]);
      return response(
        [dependabot(1), dependabot(2)],
        200,
        '<https://api.github.com/orgs/o/dependabot/alerts?per_page=100&after=2>; rel="next"',
      );
    });
    const r = await loadSecurityAlerts(apis(fetch));
    expect(fetch.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining([
        'http://b/api/proxy/github-security/dependabot?state=open&per_page=100',
        'http://b/api/proxy/github-security/dependabot?per_page=100&after=2',
        'http://b/api/proxy/github-security/code-scanning?state=open&per_page=100',
      ]),
    );
    expect(r.alerts).toHaveLength(3);
    expect(r.alerts.filter(a => a.fork)).toHaveLength(1);
    expect(r.errors).toEqual([
      expect.objectContaining({ source: 'code-scanning', status: 403 }),
    ]);
    expect(sessionStorage.length).toBe(0); // not cached while a source fails
  });

  it('caches a complete result for the session', async () => {
    const fetch = jest.fn(async (url: string) =>
      response(url.includes('dependabot') ? [dependabot(1)] : [codeScanning]),
    );
    await loadSecurityAlerts(apis(fetch));
    const again = await loadSecurityAlerts(apis(fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(again.alerts).toHaveLength(2);
  });
});
