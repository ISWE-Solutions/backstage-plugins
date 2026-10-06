export interface Config {
  ipam?: {
    phpipam?: {
      /** phpIPAM API base for the `backstage` app, e.g. https://phpipam.example.com/api/backstage */
      url: string;
      /**
       * App code of the phpIPAM `backstage` API app (SSL with app code)
       * @visibility secret
       */
      appCode: string;
      /** Verify phpIPAM's TLS certificate (default true; phpIPAM uses a self-signed one) */
      verifyTls?: boolean;
    };
    /** Pool for automatic static-address allocation (e.g. new DHIS2 containers) */
    allocation?: {
      /** Network address of the phpIPAM subnet, e.g. 10.0.0.0 */
      subnet: string;
      prefix: number;
      /** First and last address that may be allocated (inclusive) */
      from: string;
      to: string;
      gateway: string;
      /** DNS server(s) new hosts should use, shown with each allocation, e.g. "10.0.0.53" */
      nameserver?: string;
    };
    /** DHCP pools, shown on the subnet map and checked for static addresses */
    dhcpRanges?: Array<{ from: string; to: string }>;
    /** Proxmox node name -> web UI base URL, for links from addresses to guests */
    proxmoxUiUrls?: { [node: string]: string };
    /** Discovery sync reporting (the sync posts its runs to /api/ipam/sync-status) */
    sync?: {
      /** Subject of the static external-access token the sync uses; default ipam-sync */
      subject?: string;
    };
    /** DNS servers for the DNS check (default: the host's resolvers) */
    dns?: {
      servers?: string[];
    };
    /** Backstage notifications for new IPAM issues */
    notifications?: {
      enabled?: boolean;
      /** Entity refs to notify (users or groups); default group:default/phpipam-admins */
      recipients?: string[];
      /** Subnet usage percentages that trigger a notification; default [80, 90] */
      thresholds?: number[];
    };
  };
}
