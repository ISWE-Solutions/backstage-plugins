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

export interface OdooInstance {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: OdooInstanceStatus;
  version: string;
  edition: OdooEdition;
  url: string;
  domain: string;
  database: {
    name: string;
    user: string;
    host: string;
    port: number;
  };
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  addons: string[];
  workers: number;
  longpolling_port: number;
  proxy_mode: boolean;
  runbot_enabled: boolean;
  runbot_url?: string;
  created: string;
  updated: string;
}

export interface CreateOdooInstanceRequest {
  name: string;
  domain: string;
  version: string;
  edition: OdooEdition;
  node: string;
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  database: {
    name: string;
    user: string;
    password: string;
  };
  adminPassword: string;
  addons?: string[];
  workers?: number;
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
  workers?: number;
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
