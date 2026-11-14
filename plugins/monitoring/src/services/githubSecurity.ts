import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { SecurityAlert } from '../types';

/**
 * Open security alerts of a GitHub organization, through two Backstage proxy routes that each
 * point at one org-wide alert list, so the browser can reach nothing else with the token:
 *
 *   proxy:
 *     endpoints:
 *       /github-security/dependabot:
 *         target: https://api.github.com/orgs/<org>/dependabot/alerts
 *       /github-security/code-scanning:
 *         target: https://api.github.com/orgs/<org>/code-scanning/alerts
 *     (GET only, with a token that can read security alerts: classic `security_events`, or
 *      fine-grained "Dependabot alerts" and "Code scanning alerts" read)
 *
 * Secret-scanning alerts are left out on purpose: GitHub returns the secret itself.
 * Override the route prefix with `monitoring.githubSecurityProxyPath`.
 */
const DEFAULT_PROXY_PATH = '/github-security';
const MAX_PAGES = 100;

export type AlertSource = 'dependabot' | 'code-scanning';

/** The query string of the "next" link in a GitHub Link header, e.g. `?per_page=100&after=...`. */
export function nextQuery(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) {
      const q = m[1].indexOf('?');
      return q >= 0 ? m[1].slice(q) : undefined;
    }
  }
  return undefined;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type Severity = (typeof SEVERITIES)[number];
const asSeverity = (s?: string | null): Severity =>
  SEVERITIES.includes(s as Severity) ? (s as Severity) : 'low';
/** code scanning rules without a security severity: error/warning/note */
const RULE_SEVERITY: Record<string, Severity> = {
  error: 'high',
  warning: 'medium',
  note: 'low',
};

export function fromDependabot(a: any): SecurityAlert {
  const adv = a.security_advisory ?? {};
  const vuln = a.security_vulnerability ?? {};
  const pkg = a.dependency?.package ?? vuln.package ?? {};
  return {
    id: `dependabot:${a.repository?.full_name}:${a.number}`,
    source: 'dependabot',
    severity: asSeverity(vuln.severity ?? adv.severity),
    title: adv.summary ?? adv.ghsa_id ?? 'Vulnerable dependency',
    // the advisory's long description isn't shown and would overflow the session cache
    description: '',
    cve: adv.cve_id ?? adv.ghsa_id ?? undefined,
    packageName: pkg.name ?? '',
    ecosystem: pkg.ecosystem,
    currentVersion: vuln.vulnerable_version_range ?? '',
    fixedVersion: vuln.first_patched_version?.identifier ?? undefined,
    location: a.dependency?.manifest_path,
    createdAt: a.created_at,
    repository: a.repository?.name ?? '',
    repositoryUrl: a.repository?.html_url,
    fork: Boolean(a.repository?.fork),
    url: a.html_url,
    status: 'open',
  };
}

export function fromCodeScanning(a: any): SecurityAlert {
  const rule = a.rule ?? {};
  return {
    id: `code-scanning:${a.repository?.full_name}:${a.number}`,
    source: 'code-scanning',
    severity: rule.security_severity_level
      ? asSeverity(rule.security_severity_level)
      : RULE_SEVERITY[rule.severity] ?? 'low',
    title: rule.description ?? rule.name ?? rule.id ?? 'Code scanning alert',
    description: (a.most_recent_instance?.message?.text ?? '').slice(0, 300),
    cve: undefined,
    packageName: rule.id ?? '',
    ecosystem: a.tool?.name,
    currentVersion: '',
    fixedVersion: undefined,
    location: a.most_recent_instance?.location?.path,
    createdAt: a.created_at,
    repository: a.repository?.name ?? '',
    repositoryUrl: a.repository?.html_url,
    fork: Boolean(a.repository?.fork),
    url: a.html_url,
    status: 'open',
  };
}

export class GithubSecurityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly source: AlertSource,
  ) {
    super(message);
  }
}

async function loadAll(
  fetchApi: FetchApi,
  base: string,
  source: AlertSource,
  onPage?: (n: number) => void,
): Promise<any[]> {
  const out: any[] = [];
  let query: string | undefined = '?state=open&per_page=100';
  for (let page = 0; query && page < MAX_PAGES; page++) {
    const res = await fetchApi.fetch(`${base}/${source}${query}`);
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.message ?? '';
      } catch {
        // not JSON
      }
      throw new GithubSecurityError(
        `GitHub ${source} alerts: HTTP ${res.status}${
          detail ? ` (${detail})` : ''
        }`,
        res.status,
        source,
      );
    }
    out.push(...((await res.json()) as any[]));
    onPage?.(out.length);
    query = nextQuery(res.headers.get('link'));
  }
  return out;
}

export interface SecurityAlerts {
  alerts: SecurityAlert[];
  /** a source that failed (e.g. code scanning not enabled), with why */
  errors: { source: AlertSource; status: number; message: string }[];
  loadedAt: string;
}

const CACHE_KEY = 'iswe-monitoring-security-alerts';
const CACHE_MS = 15 * 60 * 1000;

/** All open Dependabot and code-scanning alerts; cached for 15 minutes in the browser session. */
export async function loadSecurityAlerts(
  apis: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    configApi: ConfigApi;
  },
  options: { refresh?: boolean; onProgress?: (loaded: number) => void } = {},
): Promise<SecurityAlerts> {
  if (!options.refresh) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as SecurityAlerts;
        if (Date.now() - Date.parse(cached.loadedAt) < CACHE_MS) return cached;
      }
    } catch {
      // no session storage
    }
  }
  const base =
    (await apis.discoveryApi.getBaseUrl('proxy')) +
    (apis.configApi.getOptionalString('monitoring.githubSecurityProxyPath') ??
      DEFAULT_PROXY_PATH);
  const counts = { dependabot: 0, 'code-scanning': 0 };
  const progress = (source: AlertSource) => (n: number) => {
    counts[source] = n;
    options.onProgress?.(counts.dependabot + counts['code-scanning']);
  };
  const errors: SecurityAlerts['errors'] = [];
  const settle = async (
    source: AlertSource,
    map: (a: any) => SecurityAlert,
  ) => {
    try {
      return (await loadAll(apis.fetchApi, base, source, progress(source))).map(
        map,
      );
    } catch (e: any) {
      errors.push({
        source,
        status: e?.status ?? 0,
        message: String(e?.message ?? e),
      });
      return [];
    }
  };
  const [dependabot, codeScanning] = await Promise.all([
    settle('dependabot', fromDependabot),
    settle('code-scanning', fromCodeScanning),
  ]);
  const result: SecurityAlerts = {
    alerts: [...dependabot, ...codeScanning],
    errors,
    loadedAt: new Date().toISOString(),
  };
  if (errors.length === 0) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(result));
    } catch {
      // too big or no session storage: no cache
    }
  }
  return result;
}

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
