export interface Config {
  proxmox?: {
    /**
     * Default cluster API base URL, e.g. https://10.20.30.10:8006
     * (the plugin appends /api2/json). Optional when using `clusters` below.
     */
    url?: string;
    /**
     * Default cluster API token in the form
     * `user@realm!tokenid=secret` (read-only, e.g. a PVEAuditor token).
     * @visibility secret
     */
    token?: string;
    /** Display name for the default cluster (default "default") */
    name?: string;
    /** Verify the Proxmox TLS certificate (default true; PVE ships a self-signed one) */
    verifyTls?: boolean;
    /** How long to cache /cluster/resources, in seconds (default 15) */
    cacheSeconds?: number;
    /** Node name -> web UI base URL, for deep links from the dashboard */
    uiUrls?: { [node: string]: string };
    /**
     * Additional clusters (read-only baseline alongside any added via the
     * Settings tab). Tokens stay in config and are never sent to the browser.
     */
    clusters?: Array<{
      name: string;
      url: string;
      /** @visibility secret */
      token: string;
      verifyTls?: boolean;
      uiUrls?: { [node: string]: string };
    }>;
    /** Thresholds for the attention/health checks */
    attention?: {
      /** Storage usage fraction to flag (default 0.9) */
      storageFull?: number;
      /** Node memory fraction to flag (default 0.9) */
      nodeMemoryHigh?: number;
      /** Guest memory fraction to flag (default 0.95) */
      guestMemoryHigh?: number;
    };
  };
}
