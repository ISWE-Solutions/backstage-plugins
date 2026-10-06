export interface Config {
  dhis2?: {
    /**
     * Defaults for the DHIS2 settings panels, used until a user saves their
     * own. Credentials are deliberately not configurable here, since this
     * block is sent to the browser.
     */
    settingsDefaults?: {
      proxmox?: {
        /**
         * Proxmox VE API base URL, e.g. https://pve.example.com:8006
         * @visibility frontend
         */
        apiUrl?: string;
        /** @visibility frontend */
        useBackstageProxy?: boolean;
        /** @visibility frontend */
        backstageProxyPath?: string;
        /** @visibility frontend */
        verifyTls?: boolean;
        /** @visibility frontend */
        defaultNode?: string;
        /** @visibility frontend */
        rootfsStorage?: string;
        /** @visibility frontend */
        templateStorage?: string;
        /** @visibility frontend */
        osTemplate?: string;
        /** @visibility frontend */
        networkBridge?: string;
        /**
         * DNS nameserver(s), space separated
         * @visibility frontend
         */
        nameserver?: string;
        /** @visibility frontend */
        searchDomain?: string;
        /** @visibility frontend */
        vmidStart?: number;
      };
      proxy?: {
        /** @visibility frontend */
        mode?: 'path' | 'subdomain';
        /**
         * Path mode: the base hostname; subdomain mode: the parent domain
         * @visibility frontend
         */
        baseDomain?: string;
        /**
         * SSH host of the nginx proxy server
         * @visibility frontend
         */
        host?: string;
        /** @visibility frontend */
        sshPort?: number;
        /** @visibility frontend */
        sshUser?: string;
        /** @visibility frontend */
        sshKeyPath?: string;
        /** @visibility frontend */
        nginxConfigPath?: string;
        /** @visibility frontend */
        letsencryptEmail?: string;
      };
      dhis2?: {
        /** @visibility frontend */
        defaultVersion?: string;
        /** @visibility frontend */
        javaHeap?: string;
        /** @visibility frontend */
        defaultCpu?: number;
        /** @visibility frontend */
        defaultMemoryMb?: number;
        /** @visibility frontend */
        defaultStorageGb?: number;
      };
      /**
       * Stored browser values to discard in favour of the defaults above,
       * e.g. a host that once shipped as a default by mistake.
       */
      replaceStoredValues?: {
        proxmox?: {
          /** @visibility frontend */
          apiUrl?: string[];
        };
        proxy?: {
          /** @visibility frontend */
          host?: string[];
          /** @visibility frontend */
          baseDomain?: string[];
        };
      };
    };
  };
}
