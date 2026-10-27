// API types and interfaces for Odoo Runbot & Proxmox Orchestration

// ============================================
// Proxmox VE Types
// ============================================

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

// ============================================
// Odoo Runbot Types
// ============================================

export type RunbotBuildState =
  | 'pending'
  | 'testing'
  | 'running'
  | 'done'
  | 'failed'
  | 'killed';

export type RunbotBuildResult = 'ok' | 'warn' | 'ko' | 'skipped' | 'killed';

export interface RunbotRepo {
  id: number;
  name: string;
  url: string;
  branch_ids: number[];
  active: boolean;
  modules: string;
  server_files: string;
  addons_paths: string;
  created: string;
  updated: string;
}

export interface RunbotBranch {
  id: number;
  name: string;
  repo_id: number;
  repo_name: string;
  sticky: boolean;
  coverage: boolean;
  state: 'pending' | 'running' | 'done' | 'error';
  last_build_id?: number;
  build_count: number;
  job_type: string;
  created: string;
  updated: string;
}

export interface RunbotBuild {
  id: number;
  branch_id: number;
  branch_name: string;
  repo_name: string;
  commit: string;
  commit_message: string;
  author: string;
  state: RunbotBuildState;
  result: RunbotBuildResult;
  host: string;
  port: number;
  dest: string;
  sequence: number;
  job: string;
  job_start: string;
  job_end?: string;
  duration: number;
  coverage_result?: number;
  build_start: string;
  build_end?: string;
  error_summary?: string;
  log_ids: number[];
  created: string;
}

export interface RunbotBuildLog {
  id: number;
  build_id: number;
  level: 'info' | 'warning' | 'error' | 'critical';
  type: string;
  name: string;
  path: string;
  message: string;
  timestamp: string;
}

export interface RunbotConfig {
  workers: number;
  running_max: number;
  job_timeout: number;
  build_timeout: number;
  default_host: string;
  nginx_enabled: boolean;
}

// ============================================
// Ansible Types
// ============================================

export type AnsiblePlaybookStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface AnsibleInventoryHost {
  name: string;
  ip: string;
  port: number;
  user: string;
  groups: string[];
  variables: Record<string, string>;
}

export interface AnsiblePlaybook {
  id: string;
  name: string;
  description: string;
  path: string;
  variables: Record<string, any>;
  tags: string[];
  created: string;
  updated: string;
}

export interface AnsiblePlaybookExecution {
  id: string;
  playbook_id: string;
  playbook_name: string;
  status: AnsiblePlaybookStatus;
  target_hosts: string[];
  extra_vars: Record<string, any>;
  output: string;
  started_at: string;
  completed_at?: string;
  duration?: number;
  stats: {
    ok: number;
    changed: number;
    unreachable: number;
    failed: number;
    skipped: number;
    rescued: number;
    ignored: number;
  };
}

export interface AnsibleRole {
  name: string;
  description: string;
  path: string;
  tasks: string[];
  handlers: string[];
  defaults: Record<string, any>;
  vars: Record<string, any>;
}

// ============================================
// Odoo Instance Types
// ============================================

export type OdooInstanceStatus =
  | 'running'
  | 'stopped'
  | 'provisioning'
  | 'error'
  | 'updating';

export type OdooEdition = 'community' | 'enterprise';

/** Decides the safe defaults and, for the shared clusters, which cluster is used */
export type OdooEnvironment = 'production' | 'staging' | 'development';

/** Container operating system (see ODOO_VERSIONS for which Odoo runs on which) */
export type OdooOs = 'ubuntu-22.04' | 'ubuntu-24.04';

/** A Git repository at a branch, tag or commit */
export interface OdooRepoSource {
  url: string;
  revision: string;
  /** Clone depth; 1 by default, 0 for the full history */
  depth?: number;
}

/** A repository of addons, checked out under <root>/addons/<name> */
export interface OdooAddonsRepo extends OdooRepoSource {
  name: string;
  /** Folder inside the repository that holds the modules, if not its root */
  subdir?: string;
  /** Catalog entity the repository was picked from, e.g. component:default/iswe-meal-addons */
  entityRef?: string;
}

/** Where an instance's code comes from; addons_path is derived from it */
export interface OdooSources {
  community: OdooRepoSource;
  /** Required for the enterprise edition */
  enterprise?: OdooRepoSource;
  addons: OdooAddonsRepo[];
}

export type PgSslMode =
  | 'disable'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

/** A shared PostgreSQL cluster an instance can use instead of a local server */
export interface PostgresCluster {
  name: string;
  environment: OdooEnvironment;
  host: string;
  port: number;
  sslmode: PgSslMode;
  description?: string;
}

/** local: PostgreSQL inside the container; cluster: a shared PostgresCluster */
export type OdooDatabasePlacement = 'local' | 'cluster';

export interface OdooDatabaseSettings {
  placement: OdooDatabasePlacement;
  /** PostgresCluster.name, for placement 'cluster' */
  cluster?: string;
  name: string;
  user: string;
  host: string;
  port: number;
  sslmode: PgSslMode;
}

export type OdooLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/** odoo.conf settings, grouped as on the Configuration step. Memory limits are in bytes. */
export interface OdooServerConfig {
  // Performance
  workers: number;
  max_cron_threads: number;
  limit_memory_soft: number;
  limit_memory_hard: number;
  limit_time_cpu: number;
  limit_time_real: number;
  limit_time_real_cron: number;
  /** Connections per Odoo process */
  db_maxconn: number;
  // Security
  list_db: boolean;
  dbfilter: string;
  proxy_mode: boolean;
  // Email
  smtp_server: string;
  smtp_port: number;
  smtp_ssl: boolean;
  smtp_user: string;
  email_from: string;
  // Logging
  log_level: OdooLogLevel;
  // Other
  without_demo: boolean;
  server_wide_modules: string[];
  data_dir: string;
  /** Any other odoo.conf option, written as is */
  custom: Record<string, string>;
}

export interface OdooInstance {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: OdooInstanceStatus;
  environment: OdooEnvironment;
  version: string;
  os: OdooOs;
  edition: OdooEdition;
  url: string;
  domain: string;
  sources: OdooSources;
  database: OdooDatabaseSettings;
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  config: OdooServerConfig;
  /** Modules to install, e.g. sale, stock */
  addons: string[];
  longpolling_port: number;
  runbot_enabled: boolean;
  runbot_url?: string;
  created: string;
  updated: string;
}

export interface CreateOdooInstanceRequest {
  name: string;
  domain: string;
  environment: OdooEnvironment;
  version: string;
  os: OdooOs;
  edition: OdooEdition;
  node: string;
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  sources: OdooSources;
  /** The database password is generated when the database is created; it is never entered here */
  database: Pick<OdooDatabaseSettings, 'placement' | 'cluster' | 'name'> &
    Partial<Pick<OdooDatabaseSettings, 'user'>>;
  config: OdooServerConfig;
  /**
   * Odoo's master password. Leave it out (recommended) to have one generated
   * and stored with the instance's other secrets.
   */
  adminPassword?: string;
  /** Modules to install */
  addons?: string[];
  runbot_enabled?: boolean;
}

export interface UpdateOdooInstanceRequest {
  name?: string;
  resources?: {
    cpu?: number;
    memory?: number;
    storage?: number;
  };
  addons?: string[];
  config?: Partial<OdooServerConfig>;
}

// ============================================
// Odoo Module Types
// ============================================

export interface OdooModule {
  name: string;
  technical_name: string;
  version: string;
  category: string;
  author: string;
  description: string;
  depends: string[];
  installed: boolean;
  state:
    | 'installed'
    | 'uninstalled'
    | 'to_install'
    | 'to_upgrade'
    | 'to_remove';
  application: boolean;
  auto_install: boolean;
  license: string;
}

// ============================================
// Dashboard Statistics
// ============================================

export interface OdooDashboardStats {
  totalInstances: number;
  runningInstances: number;
  stoppedInstances: number;
  provisioningInstances: number;
  totalBuilds: number;
  pendingBuilds: number;
  runningBuilds: number;
  failedBuilds: number;
  totalPlaybooks: number;
  runningPlaybooks: number;
  nodeCount: number;
  totalCpu: number;
  usedCpu: number;
  totalMemory: number;
  usedMemory: number;
  totalStorage: number;
  usedStorage: number;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
