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
  };
}
