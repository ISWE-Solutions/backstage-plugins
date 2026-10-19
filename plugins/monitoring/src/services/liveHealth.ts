import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  CatalogApi,
  CATALOG_FILTER_EXISTS,
} from '@backstage/plugin-catalog-react';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { ServiceHealth } from '../types';

/** URL the site checks probe for this component, e.g. `https://sso.example.org/`. */
export const HEALTH_URL_ANNOTATION = 'iswesolutions.com/health-url';
/** Comma-separated Proxmox guest names the component runs in (for CPU and memory). */
export const GUESTS_ANNOTATION = 'iswesolutions.com/proxmox-guests';

/**
 * Prometheus HTTP API reached through the Backstage proxy. The default goes through
 * Grafana's datasource proxy, so the proxy route for the Grafana plugin is enough:
 *   proxy.endpoints['/grafana/api'] -> Grafana, with a Viewer token.
 * Override with `monitoring.prometheusProxyPath` (relative to the proxy base URL).
 */
const DEFAULT_PROMETHEUS_PROXY_PATH =
  '/grafana/api/api/datasources/proxy/uid/prometheus';

// Thresholds for "degraded"
const SLOW_MS = 3000;
const CERT_DAYS = 14;
const HOT_PERCENT = 90;
const UPTIME_PERCENT = 99;

type Sample = { metric: Record<string, string>; value: [number, string] };

async function promQuery(
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

function byLabel(samples: Sample[], label: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of samples) {
    const v = Number(s.value[1]);
    if (s.metric[label] !== undefined && Number.isFinite(v))
      m.set(s.metric[label], v);
  }
  return m;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const maxOf = (values: (number | undefined)[]) => {
  const v = values.filter((x): x is number => x !== undefined);
  return v.length ? Math.max(...v) : undefined;
};

/**
 * Loads the catalog Components that carry the health-url annotation and their live health
 * from Prometheus: site check status, response time and 24 h uptime, certificate expiry, and
 * CPU and memory of their Proxmox guests (the busiest guest, for multi-guest services).
 */
export async function loadLiveServiceHealth(apis: {
  catalogApi: CatalogApi;
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
  configApi: ConfigApi;
}): Promise<ServiceHealth[]> {
  const { catalogApi, discoveryApi, fetchApi, configApi } = apis;
  const { items } = await catalogApi.getEntities({
    filter: {
      kind: 'Component',
      [`metadata.annotations.${HEALTH_URL_ANNOTATION}`]: CATALOG_FILTER_EXISTS,
    },
    fields: [
      'kind',
      'metadata.name',
      'metadata.namespace',
      'metadata.title',
      'metadata.annotations',
      'spec.system',
      'spec.type',
    ],
  });
  if (items.length === 0) return [];

  const base =
    (await discoveryApi.getBaseUrl('proxy')) +
    (configApi.getOptionalString('monitoring.prometheusProxyPath') ??
      DEFAULT_PROMETHEUS_PROXY_PATH);
  const ok = 'http_status_class=~"2xx|3xx"';
  // 1 if any probe got a 2xx/3xx; 0 (not missing) for a URL that only has
  // error-class series, so it shows as down rather than "no data"
  const [up, uptime, rt, tls, cpu, mem] = await Promise.all([
    promQuery(
      fetchApi,
      base,
      `max by (http_url) (last_over_time(httpcheck_status{${ok}}[5m])) or max by (http_url) (last_over_time(httpcheck_status[5m])) * 0`,
    ),
    promQuery(
      fetchApi,
      base,
      `avg_over_time((max by (http_url) (httpcheck_status{${ok}}))[24h:5m]) * 100`,
    ),
    promQuery(
      fetchApi,
      base,
      'max by (http_url) (last_over_time(httpcheck_duration_milliseconds[5m]))',
    ),
    promQuery(
      fetchApi,
      base,
      'min by (tlscheck_x509_cn) (last_over_time(tlscheck_time_left_seconds[30m])) / 86400',
    ),
    promQuery(
      fetchApi,
      base,
      'max by (name) (last_over_time(pve_guest_cpu_ratio[5m])) * 100',
    ),
    promQuery(
      fetchApi,
      base,
      'max by (name) (last_over_time(pve_guest_memory_used_bytes[5m])) / max by (name) (last_over_time(pve_guest_memory_max_bytes[30m])) * 100',
    ),
  ]);
  const upBy = byLabel(up, 'http_url');
  const uptimeBy = byLabel(uptime, 'http_url');
  const rtBy = byLabel(rt, 'http_url');
  const tlsBy = byLabel(tls, 'tlscheck_x509_cn');
  const cpuBy = byLabel(cpu, 'name');
  const memBy = byLabel(mem, 'name');
  const checkedAt = new Date().toISOString();

  return items
    .map((entity: Entity): ServiceHealth => {
      const ann = entity.metadata.annotations ?? {};
      const url = ann[HEALTH_URL_ANNOTATION];
      const guests = (ann[GUESTS_ANNOTATION] ?? '')
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);
      const isUp = upBy.get(url);
      const responseTimeMs = rtBy.get(url);
      const uptime24h = uptimeBy.get(url);
      const certDaysLeft = tlsBy.get(hostOf(url));
      const cpuPercent = maxOf(guests.map(g => cpuBy.get(g)));
      const memoryPercent = maxOf(guests.map(g => memBy.get(g)));

      const reasons: string[] = [];
      let status: ServiceHealth['status'];
      if (isUp === undefined) {
        status = 'unknown';
        reasons.push('No site check data for this URL');
      } else if (isUp < 1) {
        status = 'down';
        reasons.push('Site check failing (no 2xx/3xx response)');
      } else {
        if (responseTimeMs !== undefined && responseTimeMs > SLOW_MS)
          reasons.push(`Slow: ${Math.round(responseTimeMs)} ms`);
        if (certDaysLeft !== undefined && certDaysLeft < CERT_DAYS)
          reasons.push(
            `Certificate expires in ${Math.floor(certDaysLeft)} days`,
          );
        if (cpuPercent !== undefined && cpuPercent > HOT_PERCENT)
          reasons.push(`CPU at ${cpuPercent.toFixed(0)}%`);
        if (memoryPercent !== undefined && memoryPercent > HOT_PERCENT)
          reasons.push(`Memory at ${memoryPercent.toFixed(0)}%`);
        if (uptime24h !== undefined && uptime24h < UPTIME_PERCENT)
          reasons.push(`Uptime ${uptime24h.toFixed(1)}% over 24 h`);
        status = reasons.length ? 'degraded' : 'healthy';
      }
      return {
        serviceName: entity.metadata.title ?? entity.metadata.name,
        entityRef: stringifyEntityRef(entity),
        system: (entity.spec?.system as string | undefined) ?? undefined,
        url,
        guests,
        status,
        reasons,
        uptime24h,
        responseTimeMs,
        certDaysLeft,
        cpuPercent,
        memoryPercent,
        lastCheck: checkedAt,
      };
    })
    .sort((a, b) => {
      const order = { down: 0, degraded: 1, unknown: 2, healthy: 3 };
      return (
        order[a.status] - order[b.status] ||
        a.serviceName.localeCompare(b.serviceName)
      );
    });
}
