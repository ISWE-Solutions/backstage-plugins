export interface Config {
  monitoring?: {
    /**
     * Prometheus HTTP API path under the Backstage proxy, without `/api/v1/query`.
     * Defaults to `/grafana/api/api/datasources/proxy/uid/prometheus`, i.e. Grafana's
     * datasource proxy behind the `/grafana/api` proxy route used by the Grafana plugin.
     * @visibility frontend
     */
    prometheusProxyPath?: string;
    /**
     * Grafana's HTTP API under the Backstage proxy, for the Grafana Dashboards tab.
     * Defaults to `/grafana/api`.
     * @visibility frontend
     */
    grafanaProxyPath?: string;
    /**
     * Grafana's address for links, e.g. https://grafana.example.org. Defaults to the
     * default host of the community Grafana plugin's config (`grafana.hosts`), or `grafana.domain`.
     * @visibility frontend
     */
    grafanaUrl?: string;
    /**
     * Folders to show first on the Grafana Dashboards tab, in this order; the rest follow alphabetically.
     * @visibility frontend
     */
    grafanaFolderOrder?: string[];
    /**
     * Cost Insights: what Proxmox guests cost. Without any of it, example rates are shown.
     * @visibility frontend
     */
    costs?: {
      /**
       * ISO 4217 code, e.g. USD or ZMW.
       * @visibility frontend
       */
      currency?: string;
      /**
       * What the infrastructure costs per month in total (hosting, hardware, power, licences).
       * Rates are then derived from it and the cluster's capacity.
       * @visibility frontend
       */
      monthlyInfrastructureCost?: number;
      /**
       * Shares of the monthly cost per pool (should add up to 1).
       * Default cpu 0.35, memory 0.35, storage 0.15, network 0.1, backup 0.05.
       * @visibility frontend
       */
      split?: {
        /** @visibility frontend */
        cpu?: number;
        /** @visibility frontend */
        memory?: number;
        /** @visibility frontend */
        storage?: number;
        /** @visibility frontend */
        network?: number;
        /** @visibility frontend */
        backup?: number;
      };
      /**
       * Explicit prices; each overrides the derived one.
       * @visibility frontend
       */
      rates?: {
        /** per core used, per month @visibility frontend */
        cpuCoreMonth?: number;
        /** per GiB of memory, per month @visibility frontend */
        memoryGbMonth?: number;
        /** per GiB of allotted disk, per month @visibility frontend */
        storageGbMonth?: number;
        /** per GiB of network traffic @visibility frontend */
        networkGb?: number;
        /** per GiB on the backup server, per month @visibility frontend */
        backupGbMonth?: number;
        /** fixed fee per guest, per month @visibility frontend */
        guestMonth?: number;
      };
      /**
       * CPU charged on cores used (default), allotted, or a blend.
       * @visibility frontend
       */
      cpuBasis?: 'used' | 'allocated' | 'blend';
      /** @visibility frontend */
      cpuAllocatedWeight?: number;
      /**
       * Container memory charged on use, limit, or a blend (default, 50/50).
       * @visibility frontend
       */
      memoryBasis?: 'used' | 'allocated' | 'blend';
      /** @visibility frontend */
      memoryAllocatedWeight?: number;
      /**
       * VM memory: allocated by default (committed on the host while the VM runs).
       * @visibility frontend
       */
      vmMemoryBasis?: 'used' | 'allocated' | 'blend';
      /**
       * Network charged on traffic in and out (default) or out only.
       * @visibility frontend
       */
      networkDirection?: 'both' | 'out';
      /**
       * Environment tags whose guests are shared services. Default [shared].
       * @visibility frontend
       */
      sharedEnvironments?: string[];
      /**
       * Guest names that are shared services, as a regular expression.
       * Default ^(shared-|proxy$|pg0[0-9]$).
       * @visibility frontend
       */
      sharedNamePattern?: string;
    };
  };
}
