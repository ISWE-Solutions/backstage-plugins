import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';

/**
 * Prometheus HTTP API reached through the Backstage proxy. The default goes through
 * Grafana's datasource proxy, so the proxy route for the Grafana plugin is enough:
 *   proxy.endpoints['/grafana/api'] -> Grafana, with a Viewer token.
 * Override with `monitoring.prometheusProxyPath` (relative to the proxy base URL).
 */
export const DEFAULT_PROMETHEUS_PROXY_PATH =
  '/grafana/api/api/datasources/proxy/uid/prometheus';

export type Sample = {
  metric: Record<string, string>;
  value: [number, string];
};

export async function prometheusBase(
  discoveryApi: DiscoveryApi,
  configApi: ConfigApi,
): Promise<string> {
  return (
    (await discoveryApi.getBaseUrl('proxy')) +
    (configApi.getOptionalString('monitoring.prometheusProxyPath') ??
      DEFAULT_PROMETHEUS_PROXY_PATH)
  );
}

/** One instant query; throws on an HTTP error or a Prometheus error. */
export async function promQuery(
  fetchApi: FetchApi,
  base: string,
  query: string,
): Promise<Sample[]> {
  const res = await fetchApi.fetch(
    `${base}/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) {
    throw new Error(
      `Prometheus query failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = await res.json();
  if (body.status !== 'success') {
    throw new Error(
      `Prometheus query failed: ${body.error ?? 'unknown error'}`,
    );
  }
  return body.data.result as Sample[];
}

/** label value -> number, for an instant vector. */
export function byLabel(samples: Sample[], label: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of samples) {
    const v = Number(s.value[1]);
    if (s.metric[label] !== undefined && Number.isFinite(v))
      m.set(s.metric[label], v);
  }
  return m;
}

/** The single value of a scalar-like vector (or undefined). */
export function single(samples: Sample[]): number | undefined {
  const v = samples.length ? Number(samples[0].value[1]) : NaN;
  return Number.isFinite(v) ? v : undefined;
}
