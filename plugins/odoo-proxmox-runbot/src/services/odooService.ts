import {
  OdooInstance,
  CreateOdooInstanceRequest,
  UpdateOdooInstanceRequest,
  OdooModule,
  OdooDashboardStats,
  OdooEnvironment,
  OdooSources,
  PostgresCluster,
} from '../types';
import {
  defaultSources,
  hostnameFor,
  installPlaybookVars,
  odooVersions,
  resolveDatabase,
  suggestServerConfig,
  validateCreateRequest,
} from '../odooConfig';
import { proxmoxService } from './proxmoxService';
import { ansibleService } from './ansibleService';

// Sample data: shared PostgreSQL clusters, one per environment
const SAMPLE_CLUSTERS: PostgresCluster[] = [
  {
    name: 'prod',
    environment: 'production',
    host: 'pg.example.internal',
    port: 5432,
    sslmode: 'verify-full',
    description: 'Production (Patroni, 3 nodes)',
  },
  {
    name: 'stg',
    environment: 'staging',
    host: 'pg.example.internal',
    port: 5442,
    sslmode: 'verify-full',
    description: 'Staging and UAT copies',
  },
  {
    name: 'dev',
    environment: 'development',
    host: 'pg.example.internal',
    port: 5452,
    sslmode: 'verify-full',
    description: 'Development',
  },
];

const sampleSources = (
  version: string,
  enterprise: boolean,
  addons: string[],
): OdooSources => ({
  ...defaultSources(version, enterprise),
  addons: addons.map(name => ({
    name,
    url: `git@github.com:example-org/${name}.git`,
    revision: version,
    depth: 1,
  })),
});

const sampleInstance = (
  base: Omit<OdooInstance, 'sources' | 'database' | 'config' | 'os'> & {
    dbName: string;
    placement: 'local' | 'cluster';
    addonRepos: string[];
  },
): OdooInstance => {
  const { dbName, placement, addonRepos, ...rest } = base;
  const env: OdooEnvironment = base.environment;
  return {
    ...rest,
    os: base.version === '16.0' ? 'ubuntu-22.04' : 'ubuntu-24.04',
    sources: sampleSources(
      base.version,
      base.edition === 'enterprise',
      addonRepos,
    ),
    database: resolveDatabase(
      {
        placement,
        cluster: SAMPLE_CLUSTERS.find(c => c.environment === env)?.name,
        name: dbName,
      },
      SAMPLE_CLUSTERS,
    ),
    config: suggestServerConfig(base.resources, env, placement),
  };
};

/**
 * Main service for managing Odoo instances
 * Orchestrates Proxmox containers and Ansible provisioning
 */
export class OdooService {
  /**
   * Get all Odoo instances
   */
  async getInstances(): Promise<OdooInstance[]> {
    // Mock data for demonstration
    return [
      sampleInstance({
        id: 'odoo-001',
        name: 'Example ERP',
        vmid: '200',
        node: 'pve1',
        status: 'running',
        environment: 'production',
        version: '18.0',
        edition: 'enterprise',
        url: 'https://erp.example.com',
        domain: 'erp.example.com',
        dbName: 'example_odoo',
        placement: 'cluster',
        addonRepos: ['example_addons', 'oca_web'],
        resources: { cpu: 8, memory: 16384, storage: 200 },
        addons: ['sale', 'purchase', 'stock', 'account', 'mrp'],
        longpolling_port: 8072,
        runbot_enabled: false,
        created: '2026-01-10T10:00:00Z',
        updated: '2026-02-07T14:30:00Z',
      }),
      sampleInstance({
        id: 'odoo-002',
        name: 'Example ERP UAT',
        vmid: '201',
        node: 'pve2',
        status: 'running',
        environment: 'staging',
        version: '18.0',
        edition: 'enterprise',
        url: 'https://erp-uat.example.com',
        domain: 'erp-uat.example.com',
        dbName: 'example_odoo',
        placement: 'cluster',
        addonRepos: ['example_addons', 'oca_web'],
        resources: { cpu: 4, memory: 8192, storage: 100 },
        addons: ['sale', 'purchase', 'stock'],
        longpolling_port: 8072,
        runbot_enabled: true,
        runbot_url: 'https://runbot.example.com',
        created: '2026-01-15T09:00:00Z',
        updated: '2026-02-06T11:00:00Z',
      }),
      sampleInstance({
        id: 'odoo-003',
        name: 'Example Development',
        vmid: '202',
        node: 'pve1',
        status: 'stopped',
        environment: 'development',
        version: '19.0',
        edition: 'community',
        url: 'https://odoo-dev.example.com',
        domain: 'odoo-dev.example.com',
        dbName: 'example_odoo',
        placement: 'local',
        addonRepos: ['example_addons'],
        resources: { cpu: 2, memory: 4096, storage: 50 },
        addons: ['base', 'web'],
        longpolling_port: 8072,
        runbot_enabled: false,
        created: '2026-01-20T15:00:00Z',
        updated: '2026-02-01T08:00:00Z',
      }),
      sampleInstance({
        id: 'odoo-004',
        name: 'Runbot Server',
        vmid: '210',
        node: 'pve3',
        status: 'running',
        environment: 'production',
        version: '18.0',
        edition: 'community',
        url: 'https://runbot.example.com',
        domain: 'runbot.example.com',
        dbName: 'example_runbot',
        placement: 'local',
        addonRepos: ['runbot'],
        resources: { cpu: 16, memory: 32768, storage: 500 },
        addons: ['runbot', 'runbot_merge'],
        longpolling_port: 8072,
        runbot_enabled: true,
        runbot_url: 'https://runbot.example.com',
        created: '2026-01-05T10:00:00Z',
        updated: '2026-02-08T10:00:00Z',
      }),
    ];
  }

  /**
   * Get a single instance by ID
   */
  async getInstance(id: string): Promise<OdooInstance | null> {
    const instances = await this.getInstances();
    return instances.find(i => i.id === id) || null;
  }

  /**
   * Create a new Odoo instance
   */
  async createInstance(
    request: CreateOdooInstanceRequest,
  ): Promise<OdooInstance> {
    const clusters = await this.getDatabaseClusters();
    const { errors } = validateCreateRequest(request, clusters);
    if (errors.length) {
      throw new Error(`Invalid instance: ${errors.join('; ')}`);
    }
    console.log('Creating Odoo instance:', request.name);

    // The odoo-install playbook creates the guest on the configured platform
    // (Proxmox, LXD or Docker) and installs Odoo in it; nginx-proxy then puts
    // it behind nginx. Both are idempotent, so a failed run can be repeated.
    const host = hostnameFor(request.name);
    try {
      await ansibleService.executePlaybook(
        'odoo-install',
        [host],
        installPlaybookVars(request, clusters),
      );
      await ansibleService.executePlaybook('nginx-proxy', [host], {
        odoo_nginx_domain: request.domain,
        odoo_nginx_upstream_port: 8069,
        odoo_nginx_websocket_port: 8072,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Creating Odoo instance ${host} failed: ${message}. ` +
          'The playbooks are idempotent: fix the cause and create it again, or remove the guest with odoo-remove.',
      );
    }
    const vmid = await proxmoxService.getNextVmid();

    // Return the new instance
    const newInstance: OdooInstance = {
      id: `odoo-${vmid}`,
      name: request.name,
      vmid,
      node: request.node,
      status: 'provisioning',
      environment: request.environment,
      version: request.version,
      os: request.os,
      edition: request.edition,
      url: `https://${request.domain}`,
      domain: request.domain,
      sources: request.sources,
      database: resolveDatabase(request.database, clusters),
      resources: request.resources,
      config: request.config,
      addons: request.addons || [],
      longpolling_port: 8072,
      runbot_enabled: request.runbot_enabled || false,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    return newInstance;
  }

  /**
   * Update an existing instance
   */
  async updateInstance(
    id: string,
    updates: UpdateOdooInstanceRequest,
  ): Promise<OdooInstance | null> {
    console.log('Updating instance:', { id, updates });
    const instance = await this.getInstance(id);
    if (!instance) return null;

    // If resources changed, update Proxmox container
    if (updates.resources) {
      // Update container configuration
      console.log('Updating container resources');
    }

    // odoo.conf settings: odoo-configure rewrites the file and restarts Odoo
    if (updates.config) {
      await ansibleService.executePlaybook(
        'odoo-configure',
        [hostnameFor(instance.name)],
        Object.fromEntries(
          Object.entries({ ...instance.config, ...updates.config }).map(
            ([k, v]) => [`odoo_config_${k}`, v],
          ),
        ),
      );
    }

    return {
      ...instance,
      ...updates,
      resources: { ...instance.resources, ...updates.resources },
      config: { ...instance.config, ...updates.config },
      updated: new Date().toISOString(),
    };
  }

  /**
   * Delete an instance
   */
  async deleteInstance(id: string): Promise<boolean> {
    console.log('Deleting instance:', id);
    const instance = await this.getInstance(id);
    if (!instance) return false;

    // odoo-remove deletes the guest on whichever platform it runs; it refuses
    // unless the confirmation names the instance
    const host = hostnameFor(instance.name);
    try {
      await ansibleService.executePlaybook('odoo-remove', [host], {
        odoo_remove_confirm: host,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to delete Odoo instance ${id} (${host}): ${message}`,
      );
    }

    return true;
  }

  /**
   * Start an instance
   */
  async startInstance(id: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await proxmoxService.startContainer(instance.node, instance.vmid);
    return true;
  }

  /**
   * Stop an instance
   */
  async stopInstance(id: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await proxmoxService.stopContainer(instance.node, instance.vmid);
    return true;
  }

  /**
   * Restart an instance
   */
  async restartInstance(id: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await proxmoxService.restartContainer(instance.node, instance.vmid);
    return true;
  }

  /**
   * Backup an instance
   */
  async backupInstance(id: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await ansibleService.executePlaybook(
      'odoo-backup',
      [hostnameFor(instance.name)],
      {},
    );

    return true;
  }

  /**
   * Restore an instance from backup
   */
  async restoreInstance(id: string, backupFile: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    const host = hostnameFor(instance.name);
    await ansibleService.executePlaybook('odoo-restore', [host], {
      odoo_restore_from: backupFile,
      // Production refuses without it; the UI asks the user to confirm first
      odoo_restore_confirm: host,
    });

    return true;
  }

  /**
   * Upgrade an instance to a new version
   */
  async upgradeInstance(id: string, targetVersion: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    // Same major version only: the playbook refuses 17.0 -> 18.0 (a data migration)
    await ansibleService.executePlaybook(
      'odoo-upgrade',
      [hostnameFor(instance.name)],
      { odoo_upgrade_target_version: targetVersion },
    );

    return true;
  }

  /**
   * Get installed modules for an instance
   */
  async getInstanceModules(id: string): Promise<OdooModule[]> {
    console.log('Getting modules for instance:', id);
    return [
      {
        name: 'Sales',
        technical_name: 'sale',
        version: '17.0.1.0.0',
        category: 'Sales',
        author: 'Odoo SA',
        description: 'Manage sales quotations and orders',
        depends: ['base', 'product'],
        installed: true,
        state: 'installed',
        application: true,
        auto_install: false,
        license: 'LGPL-3',
      },
      {
        name: 'Purchase',
        technical_name: 'purchase',
        version: '17.0.1.0.0',
        category: 'Purchase',
        author: 'Odoo SA',
        description: 'Manage purchase orders',
        depends: ['base', 'product'],
        installed: true,
        state: 'installed',
        application: true,
        auto_install: false,
        license: 'LGPL-3',
      },
      {
        name: 'Inventory',
        technical_name: 'stock',
        version: '17.0.1.0.0',
        category: 'Inventory',
        author: 'Odoo SA',
        description: 'Manage warehouse and inventories',
        depends: ['base', 'product'],
        installed: true,
        state: 'installed',
        application: true,
        auto_install: false,
        license: 'LGPL-3',
      },
    ];
  }

  /**
   * Install a module on an instance
   */
  async installModule(
    instanceId: string,
    moduleName: string,
  ): Promise<boolean> {
    console.log('Installing module:', { instanceId, moduleName });
    return true;
  }

  /**
   * Uninstall a module from an instance
   */
  async uninstallModule(
    instanceId: string,
    moduleName: string,
  ): Promise<boolean> {
    console.log('Uninstalling module:', { instanceId, moduleName });
    return true;
  }

  /**
   * Get available Odoo versions
   */
  async getAvailableVersions(): Promise<string[]> {
    return odooVersions();
  }

  /**
   * Shared PostgreSQL clusters an instance can use instead of a local server
   */
  async getDatabaseClusters(): Promise<PostgresCluster[]> {
    return SAMPLE_CLUSTERS;
  }

  /**
   * Get dashboard statistics
   */
  async getDashboardStats(): Promise<OdooDashboardStats> {
    const instances = await this.getInstances();
    const nodes = await proxmoxService.getNodes();
    const playbooks = await ansibleService.getPlaybooks();
    const executions = await ansibleService.getExecutions();

    const runningInstances = instances.filter(
      i => i.status === 'running',
    ).length;
    const stoppedInstances = instances.filter(
      i => i.status === 'stopped',
    ).length;
    const provisioningInstances = instances.filter(
      i => i.status === 'provisioning',
    ).length;

    const totalCpu = nodes.reduce((sum, n) => sum + n.maxcpu, 0);
    const usedCpu = nodes.reduce((sum, n) => sum + n.cpu * n.maxcpu, 0);
    const totalMemory = nodes.reduce((sum, n) => sum + n.maxmem, 0);
    const usedMemory = nodes.reduce((sum, n) => sum + n.mem, 0);
    const totalStorage = nodes.reduce((sum, n) => sum + n.maxdisk, 0);
    const usedStorage = nodes.reduce((sum, n) => sum + n.disk, 0);

    const runningPlaybooks = executions.filter(
      e => e.status === 'running',
    ).length;

    return {
      totalInstances: instances.length,
      runningInstances,
      stoppedInstances,
      provisioningInstances,
      totalPlaybooks: playbooks.length,
      runningPlaybooks,
      nodeCount: nodes.length,
      totalCpu,
      usedCpu,
      totalMemory,
      usedMemory,
      totalStorage,
      usedStorage,
    };
  }

  /**
   * Clone an instance
   */
  async cloneInstance(
    sourceId: string,
    newName: string,
    newDomain: string,
  ): Promise<OdooInstance | null> {
    const source = await this.getInstance(sourceId);
    if (!source) return null;

    const newVmid = await proxmoxService.getNextVmid();

    // Clone the container
    await proxmoxService.cloneContainer(
      source.node,
      source.vmid,
      newVmid,
      newName,
    );

    // Update configuration via Ansible
    await ansibleService.executePlaybook('odoo-configure', [newName], {
      domain: newDomain,
      // Same database name: a copy lives in another cluster or container, never under a new name
      db_name: source.database.name,
    });

    return {
      ...source,
      id: `odoo-${newVmid}`,
      name: newName,
      vmid: newVmid,
      domain: newDomain,
      url: `https://${newDomain}`,
      status: 'provisioning',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }
}

export const odooService = new OdooService();
