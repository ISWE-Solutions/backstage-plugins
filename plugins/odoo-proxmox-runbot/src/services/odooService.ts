import {
  OdooInstance,
  CreateOdooInstanceRequest,
  UpdateOdooInstanceRequest,
  OdooModule,
  OdooDashboardStats,
} from '../types';
import { proxmoxService } from './proxmoxService';
import { ansibleService } from './ansibleService';
import { runbotService } from './runbotService';

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
      {
        id: 'odoo-001',
        name: 'Odoo Production',
        vmid: '200',
        node: 'pve1',
        status: 'running',
        version: '17.0',
        edition: 'enterprise',
        url: 'https://odoo-prod.example.com',
        domain: 'odoo-prod.example.com',
        database: {
          name: 'odoo_prod',
          user: 'odoo',
          host: 'localhost',
          port: 5432,
        },
        resources: {
          cpu: 8,
          memory: 16384,
          storage: 200,
        },
        addons: ['sale', 'purchase', 'stock', 'accounting', 'mrp'],
        workers: 8,
        longpolling_port: 8072,
        proxy_mode: true,
        runbot_enabled: false,
        created: '2026-01-10T10:00:00Z',
        updated: '2026-02-07T14:30:00Z',
      },
      {
        id: 'odoo-002',
        name: 'Odoo Testing',
        vmid: '201',
        node: 'pve2',
        status: 'running',
        version: '17.0',
        edition: 'community',
        url: 'https://odoo-test.example.com',
        domain: 'odoo-test.example.com',
        database: {
          name: 'odoo_test',
          user: 'odoo',
          host: 'localhost',
          port: 5432,
        },
        resources: {
          cpu: 4,
          memory: 8192,
          storage: 100,
        },
        addons: ['sale', 'purchase', 'stock'],
        workers: 4,
        longpolling_port: 8072,
        proxy_mode: true,
        runbot_enabled: true,
        runbot_url: 'https://runbot-test.example.com',
        created: '2026-01-15T09:00:00Z',
        updated: '2026-02-06T11:00:00Z',
      },
      {
        id: 'odoo-003',
        name: 'Odoo Development',
        vmid: '202',
        node: 'pve1',
        status: 'stopped',
        version: '18.0',
        edition: 'community',
        url: 'https://odoo-dev.example.com',
        domain: 'odoo-dev.example.com',
        database: {
          name: 'odoo_dev',
          user: 'odoo',
          host: 'localhost',
          port: 5432,
        },
        resources: {
          cpu: 2,
          memory: 4096,
          storage: 50,
        },
        addons: ['base', 'web'],
        workers: 2,
        longpolling_port: 8072,
        proxy_mode: false,
        runbot_enabled: false,
        created: '2026-01-20T15:00:00Z',
        updated: '2026-02-01T08:00:00Z',
      },
      {
        id: 'odoo-004',
        name: 'Runbot Server',
        vmid: '210',
        node: 'pve3',
        status: 'running',
        version: '17.0',
        edition: 'community',
        url: 'https://runbot.example.com',
        domain: 'runbot.example.com',
        database: {
          name: 'runbot',
          user: 'runbot',
          host: 'localhost',
          port: 5432,
        },
        resources: {
          cpu: 16,
          memory: 32768,
          storage: 500,
        },
        addons: ['runbot', 'runbot_merge'],
        workers: 4,
        longpolling_port: 8072,
        proxy_mode: true,
        runbot_enabled: true,
        runbot_url: 'https://runbot.example.com',
        created: '2026-01-05T10:00:00Z',
        updated: '2026-02-08T10:00:00Z',
      },
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
    console.log('Creating Odoo instance:', request);

    // 1. Get next available VMID from Proxmox
    const vmid = await proxmoxService.getNextVmid();

    // 2. Create LXC container
    let containerCreated = false;
    try {
      await proxmoxService.createContainer(request.node, vmid, {
        hostname: request.name.toLowerCase().replace(/\s+/g, '-'),
        memory: request.resources.memory,
        cores: request.resources.cpu,
        rootfs: `local-lvm:${request.resources.storage}`,
        ostemplate: 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
        network: 'name=eth0,bridge=vmbr0,ip=dhcp',
        nameserver: '8.8.8.8',
        searchdomain: 'example.com',
        unprivileged: 1,
      });
      containerCreated = true;

      // 3. Execute Ansible playbook to install Odoo
      await ansibleService.executePlaybook('odoo-install', [request.name], {
        odoo_version: request.version,
        odoo_edition: request.edition,
        odoo_workers: request.workers || 4,
        db_name: request.database.name,
        db_user: request.database.user,
        db_password: request.database.password,
        admin_password: request.adminPassword,
        addons: request.addons || [],
      });

      // 4. Configure Nginx if proxy mode enabled
      await ansibleService.executePlaybook('nginx-proxy', [request.name], {
        domain: request.domain,
        upstream_port: 8069,
        longpolling_port: 8072,
        ssl_enabled: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (containerCreated) {
        throw new Error(
          `Odoo instance provisioning failed on node ${request.node} after LXC container ${vmid} was created: ${message}. ` +
            `Container ${vmid} may need manual cleanup or a retry of provisioning.`,
        );
      }
      throw new Error(
        `Failed to create Odoo instance on node ${request.node}: ${message}`,
      );
    }

    // Return the new instance
    const newInstance: OdooInstance = {
      id: `odoo-${vmid}`,
      name: request.name,
      vmid,
      node: request.node,
      status: 'provisioning',
      version: request.version,
      edition: request.edition,
      url: `https://${request.domain}`,
      domain: request.domain,
      database: {
        name: request.database.name,
        user: request.database.user,
        host: 'localhost',
        port: 5432,
      },
      resources: request.resources,
      addons: request.addons || [],
      workers: request.workers || 4,
      longpolling_port: 8072,
      proxy_mode: true,
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

    // If addons changed, run Ansible to install/update modules
    if (updates.addons) {
      await ansibleService.executePlaybook('odoo-configure', [instance.name], {
        addons: updates.addons,
      });
    }

    return {
      ...instance,
      ...updates,
      resources: { ...instance.resources, ...updates.resources },
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

    // 1. Stop the container
    let containerStopped = false;
    try {
      await proxmoxService.stopContainer(instance.node, instance.vmid);
      containerStopped = true;

      // 2. Delete the container
      await proxmoxService.deleteContainer(instance.node, instance.vmid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (containerStopped) {
        throw new Error(
          `Failed to delete container ${instance.vmid} on node ${instance.node} after it was stopped: ${message}. ` +
            `Container ${instance.vmid} is stopped but still exists and may need manual cleanup.`,
        );
      }
      throw new Error(
        `Failed to delete Odoo instance ${id} (container ${instance.vmid} on node ${instance.node}): ${message}`,
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

    await ansibleService.executePlaybook('odoo-backup', [instance.name], {
      instance_id: id,
      backup_path: `/backups/odoo/${instance.name}`,
    });

    return true;
  }

  /**
   * Restore an instance from backup
   */
  async restoreInstance(id: string, backupFile: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await ansibleService.executePlaybook('odoo-restore', [instance.name], {
      backup_file: backupFile,
      restore_filestore: true,
    });

    return true;
  }

  /**
   * Upgrade an instance to a new version
   */
  async upgradeInstance(id: string, targetVersion: string): Promise<boolean> {
    const instance = await this.getInstance(id);
    if (!instance) return false;

    await ansibleService.executePlaybook('odoo-upgrade', [instance.name], {
      current_version: instance.version,
      target_version: targetVersion,
      backup_before_upgrade: true,
    });

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
    return ['14.0', '15.0', '16.0', '17.0', '18.0'];
  }

  /**
   * Get dashboard statistics
   */
  async getDashboardStats(): Promise<OdooDashboardStats> {
    const instances = await this.getInstances();
    const nodes = await proxmoxService.getNodes();
    const runbotStats = await runbotService.getStats();
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
      totalBuilds: runbotStats.totalBuilds,
      pendingBuilds: runbotStats.pendingBuilds,
      runningBuilds: runbotStats.runningBuilds,
      failedBuilds: runbotStats.failedBuilds,
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
      db_name: `${newName.toLowerCase().replace(/\s+/g, '_')}_db`,
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
