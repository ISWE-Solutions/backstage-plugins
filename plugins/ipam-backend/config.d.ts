export interface Config {
  ipam?: {
    phpipam?: {
      /** phpIPAM API base for the `backstage` app, e.g. https://10.20.30.127/api/backstage */
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
      /** Network address of the phpIPAM subnet, e.g. 10.20.30.0 */
      subnet: string;
      prefix: number;
      /** First and last address that may be allocated (inclusive) */
      from: string;
      to: string;
      gateway: string;
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
