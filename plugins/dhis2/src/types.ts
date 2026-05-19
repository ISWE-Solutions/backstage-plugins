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
