export interface Config {
  proxmox?: {
    /**
     * Proxmox VE API base URL, e.g. https://10.20.30.10:8006
     * (the plugin appends /api2/json).
     */
    url: string;
    /**
     * Proxmox API token in the form
     * `user@realm!tokenid=secret` (read-only, e.g. a PVEAuditor token).
     * @visibility secret
     */
    token: string;
    /** Verify the Proxmox TLS certificate (default true; PVE ships a self-signed one) */
    verifyTls?: boolean;
    /** How long to cache /cluster/resources, in seconds (default 15) */
    cacheSeconds?: number;
    /** Node name -> web UI base URL, for deep links from the dashboard */
    uiUrls?: { [node: string]: string };
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
