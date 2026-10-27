/**
 * Rules for a new Odoo instance: which Odoo runs on which OS, the addons_path
 * its sources give, odoo.conf settings suggested from the container's size,
 * safe defaults per environment, and validation. Pure functions, no I/O.
 */
import {
  CreateOdooInstanceRequest,
  OdooDatabaseSettings,
  OdooEnvironment,
  OdooOs,
  OdooServerConfig,
  OdooSources,
  PostgresCluster,
} from './types';

export interface OdooVersionInfo {
  /** Operating systems it runs on; the first is the default */
  os: OdooOs[];
  /** Still supported by Odoo S.A. (the three latest major versions) */
  supported: boolean;
}

export const ODOO_VERSIONS: Record<string, OdooVersionInfo> = {
  '19.0': { os: ['ubuntu-24.04'], supported: true },
  '18.0': { os: ['ubuntu-24.04', 'ubuntu-22.04'], supported: true },
  '17.0': { os: ['ubuntu-24.04', 'ubuntu-22.04'], supported: true },
  '16.0': { os: ['ubuntu-22.04'], supported: false },
};

export const OS_INFO: Record<
  OdooOs,
  { label: string; python: string; template: string }
> = {
  'ubuntu-24.04': {
    label: 'Ubuntu 24.04',
    python: '3.12',
    template: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
  },
  'ubuntu-22.04': {
    label: 'Ubuntu 22.04',
    python: '3.10',
    template: 'ubuntu-22.04-standard_22.04-1_amd64.tar.zst',
  },
};

export const ENVIRONMENTS: OdooEnvironment[] = [
  'production',
  'staging',
  'development',
];

export const ODOO_COMMUNITY_URL = 'https://github.com/odoo/odoo.git';
export const ODOO_ENTERPRISE_URL = 'git@github.com:odoo/enterprise.git';

/** Where the playbooks check the code out on the instance */
export const ODOO_ROOT = '/opt/odoo';

const MB = 1024 * 1024;

/** Newest first */
export function odooVersions(): string[] {
  return Object.keys(ODOO_VERSIONS).sort(
    (a, b) => parseFloat(b) - parseFloat(a),
  );
}

/** Container hostname derived from the instance name */
export function hostnameFor(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Folder name for an addons repository, from its URL */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '');
}

export function defaultSources(
  version: string,
  withEnterprise: boolean,
): OdooSources {
  return {
    community: { url: ODOO_COMMUNITY_URL, revision: version, depth: 1 },
    enterprise: withEnterprise
      ? { url: ODOO_ENTERPRISE_URL, revision: version, depth: 1 }
      : undefined,
    addons: [],
  };
}

/**
 * addons_path in the order Odoo should search it: Enterprise, then the addons
 * repositories in the order given, then Odoo's own addons.
 */
export function computeAddonsPath(
  sources: OdooSources,
  root: string = ODOO_ROOT,
): string[] {
  return [
    ...(sources.enterprise ? [`${root}/enterprise`] : []),
    ...sources.addons.map(
      a =>
        `${root}/addons/${a.name}${
          a.subdir ? `/${a.subdir.replace(/^\/+|\/+$/g, '')}` : ''
        }`,
    ),
    `${root}/odoo/addons`,
    `${root}/odoo/odoo/addons`,
  ];
}

/** The sources that apply: the Enterprise repository only counts for the enterprise edition */
export function effectiveSources(
  req: Pick<CreateOdooInstanceRequest, 'edition' | 'sources'>,
): OdooSources {
  return req.edition === 'enterprise'
    ? req.sources
    : { ...req.sources, enterprise: undefined };
}

/** The shared cluster for an environment (production → prod, and so on) */
export function clusterForEnvironment(
  environment: OdooEnvironment,
  clusters: PostgresCluster[],
): PostgresCluster | undefined {
  return clusters.find(c => c.environment === environment);
}

/** Host, port, user and TLS for the chosen placement */
export function resolveDatabase(
  db: CreateOdooInstanceRequest['database'],
  clusters: PostgresCluster[],
): OdooDatabaseSettings {
  if (db.placement === 'cluster') {
    const cluster = clusters.find(c => c.name === db.cluster);
    return {
      placement: 'cluster',
      cluster: db.cluster,
      name: db.name,
      user: db.user || `${db.name}_app`,
      host: cluster?.host ?? '',
      port: cluster?.port ?? 5432,
      sslmode: cluster?.sslmode ?? 'verify-full',
    };
  }
  return {
    placement: 'local',
    name: db.name,
    user: db.user || 'odoo',
    host: 'localhost',
    port: 5432,
    sslmode: 'prefer',
  };
}

/**
 * odoo.conf settings suggested from the container's size and environment.
 *
 * - Workers: 2 × cores + 1, capped by memory (512 MB kept for the system and
 *   about 400 MB per worker on average). Development runs threaded (0 workers),
 *   which is simpler to debug.
 * - Memory limits per worker: 80% of the container's memory shared across
 *   workers and cron threads, between 640 MB and 2 GB; hard = soft × 1.25.
 * - Production and staging: no database manager (list_db), one database per
 *   host name (dbfilter ^%d$), no demo data.
 * - Fewer connections per process on a shared cluster.
 */
export function suggestServerConfig(
  resources: { cpu: number; memory: number },
  environment: OdooEnvironment,
  placement: OdooDatabaseSettings['placement'],
): OdooServerConfig {
  const byCpu = 2 * Math.max(1, resources.cpu) + 1;
  const byMemory = Math.floor((resources.memory - 512) / 400);
  const workers =
    environment === 'development' ? 0 : Math.max(2, Math.min(byCpu, byMemory));
  const cronThreads = workers >= 4 ? 2 : 1;
  const softMb = Math.min(
    2048,
    Math.max(
      640,
      Math.floor((resources.memory * 0.8) / Math.max(1, workers + cronThreads)),
    ),
  );
  const locked = environment !== 'development';
  return {
    workers,
    max_cron_threads: cronThreads,
    limit_memory_soft: softMb * MB,
    limit_memory_hard: Math.round(softMb * 1.25) * MB,
    limit_time_cpu: 600,
    limit_time_real: 1200,
    limit_time_real_cron: -1,
    db_maxconn: placement === 'cluster' ? 16 : 64,
    list_db: !locked,
    dbfilter: locked ? '^%d$' : '.*',
    proxy_mode: true,
    smtp_server: 'localhost',
    smtp_port: 25,
    smtp_ssl: false,
    smtp_user: '',
    email_from: '',
    log_level: 'info',
    without_demo: locked,
    server_wide_modules: ['base', 'web'],
    data_dir: '/var/lib/odoo',
    custom: {},
  };
}

export interface ValidationResult {
  /** Must be fixed before the instance can be created */
  errors: string[];
  /** Allowed, but probably not what you want */
  warnings: string[];
}

const ENV_WORDS =
  /(^|_)(prod|production|staging|stg|stage|uat|test|testing|dev|development|sandbox)(_|$)/;
const VERSION_WORDS = /(^|_)(odoo\d+|v?\d{2}|\d{4})(_|$)/;
const PURPOSE_SUFFIX = /_(demo|training)$/;

/**
 * Database name rules for the shared clusters: <owner>_<app>[_<part>],
 * lowercase snake_case, at most 40 characters, no environment or version.
 */
export function checkDatabaseName(
  name: string,
  environment: OdooEnvironment,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!name) {
    errors.push('Database name is required');
    return { errors, warnings };
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    errors.push(
      'Database name: lowercase letters, digits and underscores only, starting with a letter',
    );
  }
  if (name.length > 40) errors.push('Database name: at most 40 characters');
  if (!name.includes('_')) {
    warnings.push('Database name should be <owner>_<app>, e.g. kugula_odoo');
  }
  if (ENV_WORDS.test(name)) {
    errors.push(
      'Database name must not contain the environment (prod, staging, test, dev…): the cluster is the environment',
    );
  }
  if (VERSION_WORDS.test(name)) {
    warnings.push(
      'Database name looks like it contains a version or year; leave it out',
    );
  }
  if (environment === 'production' && PURPOSE_SUFFIX.test(name)) {
    errors.push('_demo and _training databases never go in production');
  }
  return { errors, warnings };
}

export function validateCreateRequest(
  req: CreateOdooInstanceRequest,
  clusters: PostgresCluster[] = [],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prod = req.environment === 'production';

  // Basics
  if (!req.name.trim()) errors.push('Instance name is required');
  else if (!hostnameFor(req.name))
    errors.push('Instance name gives an empty hostname');
  if (
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(
      req.domain,
    )
  ) {
    errors.push('Domain must be a lowercase host name such as erp.example.com');
  }
  if (!req.node) errors.push('Choose a Proxmox node');

  // Version and OS
  const info = ODOO_VERSIONS[req.version];
  if (!info) {
    errors.push(
      `Odoo ${req.version} is not one of ${odooVersions().join(', ')}`,
    );
  } else {
    if (!info.os.includes(req.os)) {
      errors.push(
        `Odoo ${req.version} doesn't run on ${
          OS_INFO[req.os]?.label ?? req.os
        }; use ${info.os.map(o => OS_INFO[o].label).join(' or ')}`,
      );
    }
    if (!info.supported) {
      warnings.push(
        `Odoo ${req.version} no longer gets security fixes from Odoo S.A.`,
      );
    }
  }

  // Sources
  const { sources } = req;
  if (!sources.community.url || !sources.community.revision) {
    errors.push('Odoo source: repository and revision are required');
  }
  if (req.edition === 'enterprise') {
    if (!sources.enterprise?.url || !sources.enterprise.revision) {
      errors.push(
        'Enterprise edition needs the Enterprise repository and revision',
      );
    }
  } else if (sources.enterprise) {
    warnings.push(
      'Community edition: the Enterprise repository will be ignored',
    );
  }
  const seen = new Set<string>();
  sources.addons.forEach((repo, i) => {
    const label = repo.name || `Addons repository ${i + 1}`;
    if (!/^[A-Za-z0-9_.-]+$/.test(repo.name)) {
      errors.push(
        `${label}: folder name may only use letters, digits, ".", "_" and "-"`,
      );
    }
    if (seen.has(repo.name)) errors.push(`${label}: listed twice`);
    seen.add(repo.name);
    if (!repo.url) errors.push(`${label}: repository URL is required`);
    if (!repo.revision) errors.push(`${label}: revision is required`);
    else if (/^\d+\.0$/.test(repo.revision) && repo.revision !== req.version) {
      warnings.push(
        `${label}: branch ${repo.revision} is for a different Odoo version than ${req.version}`,
      );
    }
  });
  if (
    /^\d+\.0$/.test(sources.community.revision) &&
    sources.community.revision !== req.version
  ) {
    errors.push(
      `Odoo source revision ${sources.community.revision} doesn't match version ${req.version}`,
    );
  }

  // Database
  const name = checkDatabaseName(req.database.name, req.environment);
  if (req.database.placement === 'cluster') {
    errors.push(...name.errors);
    warnings.push(...name.warnings);
    const cluster = clusters.find(c => c.name === req.database.cluster);
    if (!cluster) errors.push('Choose a PostgreSQL cluster');
    else if (cluster.environment !== req.environment) {
      (prod || cluster.environment === 'production' ? errors : warnings).push(
        `A ${req.environment} instance on the ${cluster.name} cluster (meant for ${cluster.environment})`,
      );
    }
  } else {
    // Local databases aren't shared, so the naming rules are advice only
    warnings.push(
      ...name.errors.filter(e => !e.startsWith('Database name is required')),
    );
    if (!req.database.name) errors.push('Database name is required');
    if (prod) {
      warnings.push(
        'Production on a local PostgreSQL server: no high availability or point-in-time recovery; consider the prod cluster',
      );
    }
  }

  // Resources
  if (req.resources.cpu < 1) errors.push('At least 1 CPU core');
  if (req.resources.memory < 1024) errors.push('At least 1024 MB of memory');
  else if (req.resources.memory < 2048)
    warnings.push('Less than 2 GB of memory is tight for Odoo');
  if (req.resources.storage < 10) errors.push('At least 10 GB of storage');

  // Configuration
  const c = req.config;
  if (c.limit_memory_hard <= c.limit_memory_soft) {
    errors.push('Hard memory limit must be above the soft limit');
  }
  if (c.workers < 0 || c.max_cron_threads < 0)
    errors.push('Workers and cron threads cannot be negative');
  if (prod && c.workers === 0) {
    warnings.push(
      'Production with 0 workers runs threaded: no WebSocket worker and less isolation',
    );
  }
  const perProcess = c.limit_memory_soft / MB;
  const processes = c.workers + c.max_cron_threads;
  if (c.workers > 0 && perProcess * processes > req.resources.memory * 1.5) {
    warnings.push(
      `Workers could use ${Math.round(
        (perProcess * processes) / 1024,
      )} GB before recycling, well over the container's ${Math.round(
        req.resources.memory / 1024,
      )} GB`,
    );
  }
  // Errors in production, warnings in staging, fine in development
  const unsafe = (message: string) => {
    if (prod) errors.push(message);
    else if (req.environment !== 'development') warnings.push(message);
  };
  if (c.list_db) {
    unsafe(
      'The database manager (list_db) is on: anyone can reach /web/database',
    );
  }
  if (!c.dbfilter || c.dbfilter === '.*') {
    unsafe(
      'dbfilter matches every database; use ^%d$ (one database per host name)',
    );
  }
  if (!c.proxy_mode)
    warnings.push('proxy_mode is off, but the instance sits behind nginx');
  if (prod && !c.without_demo)
    errors.push('Production must not load demo data');
  if (prod && c.log_level === 'debug')
    warnings.push('Debug logging in production is noisy and slow');
  if (
    req.adminPassword !== undefined &&
    req.adminPassword.length > 0 &&
    req.adminPassword.length < 16
  ) {
    errors.push(
      'Master password: at least 16 characters, or leave it empty to have one generated',
    );
  }

  return { errors, warnings };
}

const confValue = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
};

/**
 * The odoo.conf the playbooks will write, with secrets shown as placeholders.
 */
export function renderOdooConf(
  req: CreateOdooInstanceRequest,
  clusters: PostgresCluster[] = [],
): string {
  const db = resolveDatabase(req.database, clusters);
  const c = req.config;
  const lines: [string, unknown][] = [
    ['addons_path', computeAddonsPath(effectiveSources(req))],
    ['data_dir', c.data_dir],
    ['admin_passwd', '<generated, stored with the instance>'],
    ['db_host', db.host],
    ['db_port', db.port],
    ['db_user', db.user],
    ['db_password', '<generated when the database is created>'],
    ['db_name', db.name],
    ['db_sslmode', db.sslmode],
    ['db_maxconn', c.db_maxconn],
    ['dbfilter', c.dbfilter],
    ['list_db', c.list_db],
    ['proxy_mode', c.proxy_mode],
    ['workers', c.workers],
    ['max_cron_threads', c.max_cron_threads],
    ['limit_memory_soft', c.limit_memory_soft],
    ['limit_memory_hard', c.limit_memory_hard],
    ['limit_time_cpu', c.limit_time_cpu],
    ['limit_time_real', c.limit_time_real],
    ['limit_time_real_cron', c.limit_time_real_cron],
    ['server_wide_modules', c.server_wide_modules],
    ['without_demo', c.without_demo ? 'all' : 'False'],
    ['log_level', c.log_level],
    ['smtp_server', c.smtp_server],
    ['smtp_port', c.smtp_port],
    ['smtp_ssl', c.smtp_ssl],
    ...(c.smtp_user
      ? ([
          ['smtp_user', c.smtp_user],
          ['smtp_password', '<stored with the instance>'],
        ] as [string, unknown][])
      : []),
    ...(c.email_from
      ? ([['email_from', c.email_from]] as [string, unknown][])
      : []),
    ...Object.entries(c.custom),
  ];
  return ['[options]', ...lines.map(([k, v]) => `${k} = ${confValue(v)}`)].join(
    '\n',
  );
}

/**
 * Extra variables for the odoo-install playbook. Names follow the odoo_* /
 * odoo_config_* convention of the common Ansible roles for Odoo.
 */
export function installPlaybookVars(
  req: CreateOdooInstanceRequest,
  clusters: PostgresCluster[] = [],
): Record<string, unknown> {
  const db = resolveDatabase(req.database, clusters);
  const sources = effectiveSources(req);
  const { enterprise } = sources;
  const config = Object.fromEntries(
    Object.entries(req.config)
      .filter(([k]) => k !== 'custom')
      .map(([k, v]) => [`odoo_config_${k}`, v]),
  );
  return {
    odoo_version: req.version,
    odoo_edition: req.edition,
    odoo_environment: req.environment,
    odoo_rootdir: ODOO_ROOT,
    odoo_repo_url: sources.community.url,
    odoo_repo_rev: sources.community.revision,
    odoo_repo_depth: sources.community.depth ?? 1,
    odoo_enterprise_repo_url: enterprise?.url ?? false,
    odoo_enterprise_repo_rev: enterprise?.revision ?? false,
    odoo_addons_repos: sources.addons.map(a => ({
      name: a.name,
      url: a.url,
      rev: a.revision,
      depth: a.depth ?? 1,
      subdir: a.subdir ?? '',
    })),
    odoo_config_addons_path: computeAddonsPath(sources),
    odoo_db_placement: db.placement,
    odoo_db_cluster: db.cluster ?? false,
    odoo_config_db_host: db.host,
    odoo_config_db_port: db.port,
    odoo_config_db_user: db.user,
    odoo_config_db_name: db.name,
    odoo_config_db_sslmode: db.sslmode,
    odoo_install_postgresql: db.placement === 'local',
    ...config,
    odoo_config_custom: req.config.custom,
    odoo_modules: req.addons ?? [],
  };
}
