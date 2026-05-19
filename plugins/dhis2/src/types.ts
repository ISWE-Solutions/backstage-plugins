// API types and interfaces for Proxmox VE

export interface ProxmoxNode {
  node: string;
  status: 'online' | 'offline';
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
}

export interface ProxmoxStorage {
  storage: string;
  type: string;
  content?: string;
  active?: number;
  enabled?: number;
  shared?: number;
  used?: number;
  total?: number;
  avail?: number;
}

/**
 * A single LXC container row as returned by
 * `GET /api2/json/cluster/resources?type=vm` (filtered to type === 'lxc').
 */
export interface ClusterContainer {
  vmid: number;
  name?: string;
  node: string;
  status: string;
  type: 'lxc' | 'qemu' | string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
}

export interface LXCContainer {
  vmid: string;
  name: string;
  status: 'running' | 'stopped';
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  node: string;
  template?: number;
}

export interface LXCConfig {
  hostname: string;
  memory: number;
  cores: number;
  rootfs: string;
  ostemplate: string;
  network: string;
  nameserver: string;
  searchdomain: string;
  password?: string;
  unprivileged?: number;
  features?: string;
}

export interface ProxmoxTask {
  upid: string;
  type: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
}

// DHIS2 Instance types

export interface DHIS2Instance {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error';
  version: string;
  url: string;
  domain: string;
  database: {
    name: string;
    user: string;
  };
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  created: string;
  updated: string;
}

export interface CreateInstanceRequest {
  name: string;
  domain: string;
  version: string;
  node: string;
  resources: {
    cpu: number;
    memory: number; // in MB
    storage: number; // in GB
  };
  database: {
    name: string;
    user: string;
    password: string;
  };
  adminPassword: string;
  /**
   * Optional per-instance overrides for the reverse-proxy routing settings.
   * When provided, these replace the corresponding values from the global
   * proxy settings for this instance only.
   */
  proxyOverride?: {
    mode: ProxyMode;
    baseDomain: string;
    pathPrefix?: string;
  };
  /**
   * Optional initial-data restore. When set, the orchestrator stages the
   * dump described by `restore` and loads it into the freshly created
   * PostgreSQL database before DHIS2 is started for the first time. When
   * omitted, an empty DHIS2 schema is initialised by DHIS2 itself.
   */
  restore?: RestoreSource;
  /**
   * Optional new PostgreSQL role to provision alongside the database. When
   * provided, the orchestrator (using the privileged credentials in
   * `database`) creates this role and grants it ownership of the new
   * database. DHIS2 is then configured to connect using these credentials.
   */
  newDbAccount?: {
    user: string;
    password: string;
  };
  /**
   * Optional override of the `dhis.conf` Jinja template rendered by the
   * Ansible `dhis2` role. When provided, the orchestrator writes this
   * content into the role's templates directory in place of the bundled
   * default before running the playbook. The value is the raw template
   * source (Jinja2 placeholders such as `{{ dhis2_db_host }}` are honoured).
   * When omitted, the default template shipped with the plugin is used.
   */
  dhisConfTemplate?: string;
  /**
   * Per-instance reverse-proxy configuration. Captured by the Create
   * dialog (pre-filled from the saved plugin defaults) and forwarded to
   * the orchestrator so each instance can be exposed with its own
   * routing, TLS and Nginx settings.
   */
  proxySettings?: ProxyServerSettings;
  /**
   * Per-instance DHIS2/Tomcat/Postgres/backup configuration. Captured by
   * the Create dialog (pre-filled from the saved plugin defaults) and
   * forwarded to the orchestrator. Overrides the resources / version /
   * shared Postgres / backups defaults for this instance.
   */
  dhis2Settings?: DHIS2DefaultsSettings;
}

// Restore-from-backup types

/**
 * Format of a PostgreSQL dump file. Determines which tool the playbook
 * uses to load it:
 *   - `plain`     → `psql -f` (text SQL, may be gzip/zstd compressed)
 *   - `custom`    → `pg_restore -Fc` (single-file binary `pg_dump -Fc`)
 *   - `directory` → `pg_restore -Fd` (tar-of-directory `pg_dump -Fd`)
 */
export type DumpFormat = 'plain' | 'custom' | 'directory';

/**
 * Where the DB dump should be fetched from. The shape is a discriminated
 * union on `kind` so the UI / backend / Ansible can switch behaviour
 * exhaustively. Credentials supplied here are transient and are never
 * persisted in the browser (use plugin Settings for long-lived secrets).
 */
export type RestoreSource =
  | {
      kind: 'upload';
      /** Opaque token returned by POST /api/dhis2/restore/upload */
      uploadToken: string;
      originalFilename: string;
      sizeBytes: number;
      format: DumpFormat;
    }
  | {
      kind: 'url';
      url: string;
      format: DumpFormat;
      /** Optional auth/custom headers forwarded by the backend when fetching the URL */
      headers?: Record<string, string>;
    }
  | {
      kind: 's3';
      bucket: string;
      key: string;
      region?: string;
      /** Custom S3-compatible endpoint (MinIO, Wasabi, R2, …). Empty = AWS. */
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      format: DumpFormat;
      /**
       * When true, missing credentials fall back to the plugin settings
       * (the configured offsite backup bucket credentials).
       */
      useSettingsCredentials?: boolean;
    }
  | {
      kind: 'instance';
      /** id of a managed DHIS2 instance to clone via live pg_dump */
      sourceInstanceId: string;
      /** Also copy the DHIS2 files dir (uploaded resources). Default false. */
      includeFiles?: boolean;
    }
  | {
      kind: 'vzdump';
      /** Proxmox node that owns the backup storage */
      node: string;
      /** Storage id (must have `content` including `backup`) */
      storage: string;
      /** Volid of the vzdump archive, e.g. `local:backup/vzdump-lxc-100-2026_05_01-02_00_00.tar.zst` */
      volid: string;
    }
  | {
      kind: 'local';
      /** Proxmox node where the dump file lives */
      node: string;
      /** Absolute path on the host */
      path: string;
      format: DumpFormat;
    };

/**
 * Status of a restore job (initial or post-create). Mirrors `AnsibleTask`
 * shape so the existing logs/progress UI can be reused.
 */
export interface RestoreJob {
  jobId: string;
  instanceId: string;
  status:
    | 'queued'
    | 'staging'
    | 'restoring'
    | 'completed'
    | 'failed'
    | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  message?: string;
}

// Nginx configuration types

export interface NginxUpstream {
  name: string;
  servers: string[];
}

export interface NginxServer {
  domain: string;
  upstreamName: string;
  sslCert?: string;
  sslKey?: string;
}

export interface NginxConfig {
  upstreams: NginxUpstream[];
  servers: NginxServer[];
}

// Plugin settings types

export type ProxmoxAuthMethod = 'token' | 'password';

export interface ProxmoxClusterSettings {
  /** Proxmox VE API base URL, e.g. https://pve.example.org:8006 */
  apiUrl: string;
  /**
   * If true (recommended), route Proxmox API calls through the Backstage
   * backend proxy (configured in app-config.yaml under `proxy./proxmox`)
   * instead of calling the Proxmox API directly from the browser. This
   * avoids CORS, self-signed TLS, and private-network reachability issues,
   * and keeps the API token off the client.
   */
  useBackstageProxy: boolean;
  /** Backstage proxy path, e.g. /api/proxy/proxmox */
  backstageProxyPath: string;
  authMethod: ProxmoxAuthMethod;
  /** Token id, e.g. backstage@pve!orchestrator */
  tokenId?: string;
  /** API token secret (UUID) */
  tokenSecret?: string;
  /** Username, e.g. root@pam (used for password auth) */
  username?: string;
  password?: string;
  /** Verify TLS certificate of the Proxmox API */
  verifyTls: boolean;
  /** Default Proxmox node to schedule containers on */
  defaultNode: string;
  /** Storage pool for container rootfs (e.g. local-lvm) */
  rootfsStorage: string;
  /** Storage location for templates (e.g. local) */
  templateStorage: string;
  /** OS template volume id, e.g. local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst */
  osTemplate: string;
  /** Network bridge for LXC containers (e.g. vmbr0) */
  networkBridge: string;
  /** DNS nameserver(s), space separated */
  nameserver: string;
  /** DNS search domain */
  searchDomain: string;
  /** Starting VMID for newly provisioned DHIS2 containers */
  vmidStart: number;
  /** Make containers unprivileged */
  unprivileged: boolean;
  /** Start container on boot */
  startOnBoot: boolean;
}

export type ProxyMode = 'path' | 'subdomain';

export type ProxyAuthMethod = 'ssh-key' | 'password';

export type SslProvider = 'letsencrypt' | 'manual' | 'none';

export interface ProxyServerSettings {
  /** Whether instances are exposed at base/<instance> or <instance>.base */
  mode: ProxyMode;
  /**
   * For path mode: the full base URL (e.g. dhis2.example.org).
   * For subdomain mode: the parent domain (e.g. example.org) — instances
   * become <name>.<baseDomain>.
   */
  baseDomain: string;
  /** Optional path prefix used in path-mode, e.g. "" or "dhis2" */
  pathPrefix?: string;
  /** SSH host of the dedicated proxy server */
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: ProxyAuthMethod;
  /** Path on the Backstage backend to the private SSH key */
  sshKeyPath?: string;
  sshPassword?: string;
  /** Directory on the proxy server where per-site configs are written */
  nginxConfigPath: string;
  /** Command to reload nginx after writing configs */
  nginxReloadCommand: string;
  /** SSL provisioning strategy */
  sslProvider: SslProvider;
  /** Email used for Let's Encrypt registration */
  letsencryptEmail?: string;
  /** Path to manually-provided wildcard cert (mode=manual) */
  sslCertPath?: string;
  sslKeyPath?: string;
  /** Redirect HTTP traffic to HTTPS */
  forceHttps: boolean;
  /** Add HSTS header */
  enableHsts: boolean;
  /** Upstream port DHIS2/Tomcat listens on inside the container */
  upstreamPort: number;
}

export interface DHIS2DefaultsSettings {
  /** Default DHIS2 version for new instances */
  defaultVersion: string;
  /** Default JVM heap size, e.g. "4g" */
  javaHeap: string;
  /** Tomcat port inside the container */
  tomcatPort: number;
  /** Default LXC resources */
  defaultCpu: number;
  defaultMemoryMb: number;
  defaultStorageGb: number;
  /** PostgreSQL: shared external host, or empty to install per-instance */
  postgresHost: string;
  postgresPort: number;
  /** Admin user used to create per-instance databases on the shared host */
  postgresAdminUser: string;
  postgresAdminPassword: string;
  /** Backup configuration */
  backupEnabled: boolean;
  /** Cron expression for nightly backups */
  backupSchedule: string;
  /** Retention in days */
  backupRetentionDays: number;
  /** S3-compatible bucket / path for offsite backups (optional) */
  backupBucket?: string;
}

export interface DHIS2PluginSettings {
  proxmox: ProxmoxClusterSettings;
  proxy: ProxyServerSettings;
  dhis2: DHIS2DefaultsSettings;
}

// Orchestration logs

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogAction =
  | 'create-instance'
  | 'start-instance'
  | 'stop-instance'
  | 'restart-instance'
  | 'delete-instance'
  | 'update-resources'
  | 'proxy-update'
  | 'proxmox-api'
  | 'backup'
  | 'system';

export interface OrchestrationLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  action: LogAction;
  message: string;
  /** Optional related instance id */
  instanceId?: string;
  /** Optional instance display name (denormalised for the UI) */
  instanceName?: string;
  /** Optional Proxmox task UPID */
  taskId?: string;
  /** User who triggered the action */
  user?: string;
  /** Free-form structured details */
  details?: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: DHIS2PluginSettings = {
  proxmox: {
    apiUrl: 'https://pve.example.com:8006',
    useBackstageProxy: true,
    backstageProxyPath: '/api/proxy/proxmox',
    authMethod: 'token',
    tokenId: '',
    tokenSecret: '',
    username: 'root@pam',
    password: '',
    verifyTls: true,
    defaultNode: 'pve1',
    rootfsStorage: 'local-lvm',
    templateStorage: 'local',
    osTemplate: 'local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst',
    networkBridge: 'vmbr0',
    nameserver: '1.1.1.1 8.8.8.8',
    searchDomain: 'example.com',
    vmidStart: 200,
    unprivileged: true,
    startOnBoot: true,
  },
  proxy: {
    mode: 'path',
    baseDomain: 'dhis2.example.com',
    pathPrefix: '',
    host: 'proxy.example.com',
    sshPort: 22,
    sshUser: 'root',
    authMethod: 'ssh-key',
    sshKeyPath: '/var/lib/backstage/.ssh/id_ed25519',
    sshPassword: '',
    nginxConfigPath: '/etc/nginx/conf.d',
    nginxReloadCommand: 'sudo systemctl reload nginx',
    sslProvider: 'letsencrypt',
    letsencryptEmail: '',
    sslCertPath: '',
    sslKeyPath: '',
    forceHttps: true,
    enableHsts: true,
    upstreamPort: 8080,
  },
  dhis2: {
    defaultVersion: '2.40.3',
    javaHeap: '4g',
    tomcatPort: 8080,
    defaultCpu: 4,
    defaultMemoryMb: 8192,
    defaultStorageGb: 100,
    postgresHost: '',
    postgresPort: 5432,
    postgresAdminUser: 'postgres',
    postgresAdminPassword: '',
    backupEnabled: true,
    backupSchedule: '0 2 * * *',
    backupRetentionDays: 14,
    backupBucket: '',
  },
};
