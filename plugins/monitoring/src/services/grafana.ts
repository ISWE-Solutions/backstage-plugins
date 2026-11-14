import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { GrafanaDashboard } from '../types';

/**
 * Grafana's HTTP API under the Backstage proxy: the same route as the Prometheus queries,
 *   proxy.endpoints['/grafana/api'] -> Grafana, with a Viewer token (GET only).
 * Override with `monitoring.grafanaProxyPath`.
 */
const DEFAULT_GRAFANA_PROXY_PATH = '/grafana/api';

/**
 * Grafana's address for links: `monitoring.grafanaUrl`, else the default host of the community
 * Grafana plugin's config (`grafana.hosts` / `grafana.defaultHost`), else `grafana.domain`.
 */
export function grafanaUrl(configApi: ConfigApi): string | undefined {
  const own = configApi.getOptionalString('monitoring.grafanaUrl');
  if (own) return own.replace(/\/+$/, '');
  const hosts = configApi.getOptionalConfigArray('grafana.hosts') ?? [];
  const id = configApi.getOptionalString('grafana.defaultHost');
  const host = hosts.find(h => h.getOptionalString('id') === id) ?? hosts[0];
  const domain =
    host?.getOptionalString('domain') ??
    configApi.getOptionalString('grafana.domain');
  return domain?.replace(/\/+$/, '');
}

type SearchHit = {
  uid: string;
  title: string;
  url: string;
  tags?: string[];
  folderTitle?: string;
  isStarred?: boolean;
  type?: string;
};

/** Every dashboard the Viewer token can see, with links into Grafana. */
export async function loadGrafanaDashboards(apis: {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
  configApi: ConfigApi;
}): Promise<GrafanaDashboard[]> {
  const { discoveryApi, fetchApi, configApi } = apis;
  const base =
    (await discoveryApi.getBaseUrl('proxy')) +
    (configApi.getOptionalString('monitoring.grafanaProxyPath') ??
      DEFAULT_GRAFANA_PROXY_PATH);
  const res = await fetchApi.fetch(
    `${base}/api/search?type=dash-db&limit=5000`,
  );
  if (!res.ok) {
    throw new Error(
      `Grafana search failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const hits = (await res.json()) as SearchHit[];
  const root = grafanaUrl(configApi) ?? '';
  return hits
    .filter(h => !h.type || h.type === 'dash-db')
    .map(h => ({
      id: h.uid,
      uid: h.uid,
      title: h.title,
      url: `${root}${h.url}`,
      tags: h.tags ?? [],
      starred: Boolean(h.isStarred),
      folderTitle: h.folderTitle || 'General',
    }));
}

/**
 * Dashboards by folder: folders named in `order` first, in that order, then the rest
 * alphabetically; dashboards alphabetically within a folder.
 */
export function byFolder(
  dashboards: GrafanaDashboard[],
  order: string[] = [],
): { folder: string; dashboards: GrafanaDashboard[] }[] {
  const m = new Map<string, GrafanaDashboard[]>();
  for (const d of dashboards) {
    const f = d.folderTitle ?? 'General';
    m.set(f, [...(m.get(f) ?? []), d]);
  }
  const rank = (f: string) => {
    const i = order.indexOf(f);
    return i < 0 ? order.length : i;
  };
  return [...m.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([folder, list]) => ({
      folder,
      dashboards: list.sort((a, b) => a.title.localeCompare(b.title)),
    }));
}
