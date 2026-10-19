export interface Config {
  monitoring?: {
    /**
     * Prometheus HTTP API path under the Backstage proxy, without `/api/v1/query`.
     * Defaults to `/grafana/api/api/datasources/proxy/uid/prometheus`, i.e. Grafana's
     * datasource proxy behind the `/grafana/api` proxy route used by the Grafana plugin.
     * @visibility frontend
     */
    prometheusProxyPath?: string;
  };
}
