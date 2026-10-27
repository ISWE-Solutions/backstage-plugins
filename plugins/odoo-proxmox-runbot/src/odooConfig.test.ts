import {
  checkDatabaseName,
  computeAddonsPath,
  defaultSources,
  hostnameFor,
  installPlaybookVars,
  odooVersions,
  renderOdooConf,
  repoNameFromUrl,
  resolveDatabase,
  suggestServerConfig,
  validateCreateRequest,
} from './odooConfig';
import { CreateOdooInstanceRequest, PostgresCluster } from './types';

const clusters: PostgresCluster[] = [
  {
    name: 'prod',
    environment: 'production',
    host: 'pg',
    port: 5432,
    sslmode: 'verify-full',
  },
  {
    name: 'stg',
    environment: 'staging',
    host: 'pg',
    port: 5442,
    sslmode: 'verify-full',
  },
  {
    name: 'dev',
    environment: 'development',
    host: 'pg',
    port: 5452,
    sslmode: 'verify-full',
  },
];

const request = (
  patch: Partial<CreateOdooInstanceRequest> = {},
): CreateOdooInstanceRequest => {
  const resources = { cpu: 4, memory: 8192, storage: 100 };
  return {
    name: 'Kugula ERP',
    domain: 'erp.kugula.example.com',
    environment: 'production',
    version: '18.0',
    os: 'ubuntu-24.04',
    edition: 'community',
    node: 'pve1',
    resources,
    sources: {
      ...defaultSources('18.0', false),
      addons: [
        {
          name: 'kugula_addons',
          url: 'git@github.com:org/kugula_addons.git',
          revision: '18.0',
        },
        {
          name: 'oca_web',
          url: 'https://github.com/OCA/web.git',
          revision: '18.0',
          subdir: '/',
        },
      ],
    },
    database: { placement: 'cluster', cluster: 'prod', name: 'kugula_odoo' },
    config: suggestServerConfig(resources, 'production', 'cluster'),
    ...patch,
  };
};

describe('versions and names', () => {
  it('lists versions newest first, with 19.0', () => {
    expect(odooVersions()[0]).toBe('19.0');
  });

  it('derives hostnames and repository folders', () => {
    expect(hostnameFor('  Kugula ERP (UAT) ')).toBe('kugula-erp-uat');
    expect(
      repoNameFromUrl('git@github.com:ISWE-Solutions/iswe_meal_addons.git'),
    ).toBe('iswe_meal_addons');
    expect(repoNameFromUrl('https://github.com/OCA/web/')).toBe('web');
  });
});

describe('computeAddonsPath', () => {
  it('puts Enterprise first, then addons in order, then Odoo', () => {
    const sources = {
      ...defaultSources('18.0', true),
      addons: [
        { name: 'a', url: 'u', revision: '18.0' },
        { name: 'b', url: 'u', revision: '18.0', subdir: 'modules/' },
      ],
    };
    expect(computeAddonsPath(sources, '/opt/odoo')).toEqual([
      '/opt/odoo/enterprise',
      '/opt/odoo/addons/a',
      '/opt/odoo/addons/b/modules',
      '/opt/odoo/odoo/addons',
      '/opt/odoo/odoo/odoo/addons',
    ]);
  });
});

describe('suggestServerConfig', () => {
  it('sizes workers by CPU and memory, with safe production defaults', () => {
    const c = suggestServerConfig(
      { cpu: 4, memory: 8192 },
      'production',
      'cluster',
    );
    expect(c.workers).toBe(9); // 2 × 4 + 1; memory allows 19
    expect(c.max_cron_threads).toBe(2);
    expect(c.limit_memory_hard).toBeGreaterThan(c.limit_memory_soft);
    expect(c).toMatchObject({
      list_db: false,
      dbfilter: '^%d$',
      without_demo: true,
      db_maxconn: 16,
    });
  });

  it('caps workers by memory and runs development threaded', () => {
    expect(
      suggestServerConfig({ cpu: 8, memory: 2048 }, 'staging', 'local').workers,
    ).toBe(3);
    const dev = suggestServerConfig(
      { cpu: 4, memory: 8192 },
      'development',
      'local',
    );
    expect(dev).toMatchObject({
      workers: 0,
      list_db: true,
      without_demo: false,
      db_maxconn: 64,
    });
  });
});

describe('checkDatabaseName', () => {
  it('accepts <owner>_<app>[_<part>]', () => {
    expect(checkDatabaseName('kugula_odoo', 'production')).toEqual({
      errors: [],
      warnings: [],
    });
    expect(
      checkDatabaseName('weeffect_dhis2_mbdos', 'production').errors,
    ).toEqual([]);
  });

  it('rejects environments, capitals and purpose suffixes in production', () => {
    expect(
      checkDatabaseName('kugula_odoo_prod', 'production').errors,
    ).toHaveLength(1);
    expect(checkDatabaseName('Kugula_Odoo', 'production').errors).toHaveLength(
      1,
    );
    expect(
      checkDatabaseName('boardfusion_odoo_demo', 'production').errors,
    ).toHaveLength(1);
    expect(
      checkDatabaseName('boardfusion_odoo_demo', 'staging').errors,
    ).toEqual([]);
    expect(checkDatabaseName('pia_odoo19', 'production').warnings).toHaveLength(
      1,
    );
  });
});

describe('validateCreateRequest', () => {
  it('accepts a sound production request', () => {
    expect(validateCreateRequest(request(), clusters)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('enforces the version and OS pairs', () => {
    const { errors } = validateCreateRequest(
      request({
        version: '19.0',
        os: 'ubuntu-22.04',
        sources: defaultSources('19.0', false),
      }),
      clusters,
    );
    expect(errors).toEqual([
      expect.stringContaining("doesn't run on Ubuntu 22.04"),
    ]);
  });

  it('requires the Enterprise source for the enterprise edition', () => {
    const { errors } = validateCreateRequest(
      request({ edition: 'enterprise' }),
      clusters,
    );
    expect(errors).toEqual([expect.stringContaining('Enterprise repository')]);
  });

  it('refuses unsafe production settings', () => {
    const req = request();
    req.config = {
      ...req.config,
      list_db: true,
      dbfilter: '.*',
      without_demo: false,
    };
    expect(validateCreateRequest(req, clusters).errors).toHaveLength(3);
    // The same in development is fine
    const dev = request({
      environment: 'development',
      database: { placement: 'cluster', cluster: 'dev', name: 'kugula_odoo' },
    });
    dev.config = {
      ...dev.config,
      list_db: true,
      dbfilter: '.*',
      without_demo: false,
    };
    expect(validateCreateRequest(dev, clusters).errors).toEqual([]);
  });

  it('flags a cluster from another environment, mismatched branches and a short master password', () => {
    const req = request({
      database: { placement: 'cluster', cluster: 'dev', name: 'kugula_odoo' },
      adminPassword: 'short',
    });
    req.sources.addons[0].revision = '17.0';
    const { errors, warnings } = validateCreateRequest(req, clusters);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dev cluster'),
        expect.stringContaining('Master password'),
      ]),
    );
    expect(warnings).toEqual([expect.stringContaining('branch 17.0')]);
  });

  it('treats naming rules as advice for a local database', () => {
    const { errors, warnings } = validateCreateRequest(
      request({ database: { placement: 'local', name: 'Production' } }),
      clusters,
    );
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(1);
  });
});

describe('outputs', () => {
  it('resolves the cluster connection and the app role', () => {
    expect(
      resolveDatabase(
        { placement: 'cluster', cluster: 'stg', name: 'kugula_odoo' },
        clusters,
      ),
    ).toEqual({
      placement: 'cluster',
      cluster: 'stg',
      name: 'kugula_odoo',
      user: 'kugula_odoo_app',
      host: 'pg',
      port: 5442,
      sslmode: 'verify-full',
    });
  });

  it('renders odoo.conf without secrets and ignores Enterprise on community', () => {
    const req = request();
    req.sources.enterprise = { url: 'x', revision: '18.0' };
    const conf = renderOdooConf(req, clusters);
    expect(conf).toContain('db_user = kugula_odoo_app');
    expect(conf).toContain('list_db = False');
    expect(conf).toContain('admin_passwd = <generated');
    expect(conf).not.toContain('/opt/odoo/enterprise');
  });

  it('builds playbook variables', () => {
    const vars = installPlaybookVars(request(), clusters);
    expect(vars).toMatchObject({
      odoo_guest_name: 'kugula-erp',
      odoo_guest_os: 'ubuntu-24.04',
      odoo_guest_memory: 8192,
      odoo_proxmox_node: 'pve1',
      odoo_nginx_domain: 'erp.kugula.example.com',
      odoo_version: '18.0',
      odoo_repo_rev: '18.0',
      odoo_enterprise_repo_url: false,
      odoo_install_postgresql: false,
      odoo_config_db_port: 5432,
      odoo_config_dbfilter: '^%d$',
    });
    expect(vars.odoo_addons_repos).toHaveLength(2);
    expect(vars).not.toHaveProperty('odoo_config_custom.admin_passwd');
    expect(vars).not.toHaveProperty('odoo_admin_password');
    expect(
      installPlaybookVars(
        { ...request(), adminPassword: 'x'.repeat(20) },
        clusters,
      ),
    ).toHaveProperty('odoo_admin_password');
  });
});
