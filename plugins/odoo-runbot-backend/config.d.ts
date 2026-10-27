export interface Config {
  odooRunbot?: {
    github?: {
      /**
       * Token for polling repositories and posting commit statuses. Defaults to
       * the github.com integration's token. Private repositories need the repo
       * scope (or a fine-grained token with Contents read and Commit statuses write).
       * @visibility secret
       */
      token?: string;
      /** Post commit statuses (ci/runbot-<trigger>); default true */
      statuses?: boolean;
    };
    /** Seconds between GitHub polls; default 60 */
    pollSeconds?: number;
    /** Path of the Odoo page in the app, for links in commit statuses; default /odoo */
    pagePath?: string;
    builder?: {
      /**
       * Subject of the static token builders use (backend.auth.externalAccess);
       * default odoo-runbot-builder
       */
      subject?: string;
    };
  };
}
