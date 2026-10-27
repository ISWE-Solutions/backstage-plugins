import {
  AnsiblePlaybook,
  AnsiblePlaybookExecution,
  AnsibleInventoryHost,
  AnsibleRole,
} from '../types';

/**
 * Service for managing Ansible playbooks and executions
 * Used for provisioning and configuring Odoo instances
 */
export class AnsibleService {
  /**
   * Get all available playbooks
   */
  async getPlaybooks(): Promise<AnsiblePlaybook[]> {
    // The playbooks shipped in this package's ansible/ folder; the backend runs them
    return [
      {
        id: 'odoo-install',
        name: 'Odoo installation',
        description:
          'Create the guest (Proxmox LXC, LXD or Docker, per odoo_platform) and install Odoo: sources, Python, wkhtmltopdf, database, odoo.conf and service',
        path: 'ansible/playbooks/odoo-install.yml',
        variables: {
          odoo_platform: 'proxmox',
          odoo_version: '18.0',
          odoo_edition: 'community',
          odoo_environment: 'staging',
          odoo_addons_repos: [],
          odoo_db_placement: 'cluster',
          odoo_config_workers: 4,
        },
        tags: ['install', 'odoo', 'proxmox', 'lxd', 'docker', 'postgresql'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'odoo-configure',
        name: 'Odoo configuration',
        description:
          'Rewrite odoo.conf and the systemd unit from the current settings; restart if they changed',
        path: 'ansible/playbooks/odoo-configure.yml',
        variables: { odoo_config_workers: 4, odoo_config_log_level: 'info' },
        tags: ['configure', 'odoo'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'nginx-proxy',
        name: 'Nginx proxy',
        description:
          "nginx in front of the instance with WebSocket; TLS from Let's Encrypt, your own certificate, or none behind another proxy",
        path: 'ansible/playbooks/nginx-proxy.yml',
        variables: {
          odoo_nginx_domain: 'erp.example.com',
          odoo_nginx_tls: 'certbot',
        },
        tags: ['nginx', 'tls'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'odoo-backup',
        name: 'Odoo backup',
        description:
          'Database (pg_dump), filestore, odoo.conf and code revisions, keeping the newest backups',
        path: 'ansible/playbooks/odoo-backup.yml',
        variables: {
          odoo_backup_dir: '/var/backups/odoo',
          odoo_backup_keep: 7,
        },
        tags: ['backup', 'odoo'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'odoo-restore',
        name: 'Odoo restore',
        description:
          'Replace the database and filestore with a backup; takes a safety backup first. Production needs odoo_restore_confirm',
        path: 'ansible/playbooks/odoo-restore.yml',
        variables: { odoo_restore_from: '', odoo_restore_confirm: '' },
        tags: ['restore', 'odoo'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'odoo-upgrade',
        name: 'Odoo update',
        description:
          'Back up, move the code to its configured revisions, update modules and restart (same major version)',
        path: 'ansible/playbooks/odoo-upgrade.yml',
        variables: { odoo_upgrade_modules: ['all'] },
        tags: ['upgrade', 'odoo'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
      {
        id: 'odoo-remove',
        name: 'Remove instance',
        description:
          'Delete the guest and its data; needs odoo_remove_confirm set to the instance name',
        path: 'ansible/playbooks/odoo-remove.yml',
        variables: { odoo_remove_confirm: '' },
        tags: ['remove'],
        created: '2026-10-27T00:00:00Z',
        updated: '2026-10-27T00:00:00Z',
      },
    ];
  }

  /**
   * Get a specific playbook by ID
   */
  async getPlaybook(id: string): Promise<AnsiblePlaybook | null> {
    const playbooks = await this.getPlaybooks();
    return playbooks.find(p => p.id === id) || null;
  }

  /**
   * Execute a playbook
   */
  async executePlaybook(
    playbookId: string,
    targetHosts: string[],
    extraVars: Record<string, any> = {},
  ): Promise<AnsiblePlaybookExecution> {
    const playbook = await this.getPlaybook(playbookId);
    if (!playbook) {
      throw new Error(`Playbook not found: ${playbookId}`);
    }

    console.log('Executing playbook:', { playbookId, targetHosts, extraVars });

    const execution: AnsiblePlaybookExecution = {
      id: `exec-${Date.now()}`,
      playbook_id: playbookId,
      playbook_name: playbook.name,
      status: 'running',
      target_hosts: targetHosts,
      extra_vars: { ...playbook.variables, ...extraVars },
      output: '',
      started_at: new Date().toISOString(),
      stats: {
        ok: 0,
        changed: 0,
        unreachable: 0,
        failed: 0,
        skipped: 0,
        rescued: 0,
        ignored: 0,
      },
    };

    return execution;
  }

  /**
   * Get playbook execution history
   */
  async getExecutions(): Promise<AnsiblePlaybookExecution[]> {
    return [
      {
        id: 'exec-001',
        playbook_id: 'odoo-install',
        playbook_name: 'Odoo installation',
        status: 'success',
        target_hosts: ['odoo-prod-01'],
        extra_vars: { odoo_version: '17.0' },
        output: 'PLAY [Install Odoo] ****...',
        started_at: '2026-02-07T10:00:00Z',
        completed_at: '2026-02-07T10:15:00Z',
        duration: 900,
        stats: {
          ok: 45,
          changed: 23,
          unreachable: 0,
          failed: 0,
          skipped: 5,
          rescued: 0,
          ignored: 0,
        },
      },
      {
        id: 'exec-002',
        playbook_id: 'nginx-proxy',
        playbook_name: 'Nginx proxy',
        status: 'success',
        target_hosts: ['example-erp-uat'],
        extra_vars: {
          odoo_nginx_domain: 'erp-uat.example.com',
          odoo_nginx_tls: 'none',
        },
        output: 'PLAY [Setup Runbot] ****...',
        started_at: '2026-02-06T14:00:00Z',
        completed_at: '2026-02-06T14:20:00Z',
        duration: 1200,
        stats: {
          ok: 38,
          changed: 18,
          unreachable: 0,
          failed: 0,
          skipped: 3,
          rescued: 0,
          ignored: 0,
        },
      },
      {
        id: 'exec-003',
        playbook_id: 'odoo-backup',
        playbook_name: 'Odoo backup',
        status: 'success',
        target_hosts: ['odoo-prod-01', 'odoo-test-01'],
        extra_vars: {},
        output: 'PLAY [Backup Odoo] ****...',
        started_at: '2026-02-08T02:00:00Z',
        completed_at: '2026-02-08T02:10:00Z',
        duration: 600,
        stats: {
          ok: 12,
          changed: 4,
          unreachable: 0,
          failed: 0,
          skipped: 0,
          rescued: 0,
          ignored: 0,
        },
      },
    ];
  }

  /**
   * Get a specific execution by ID
   */
  async getExecution(id: string): Promise<AnsiblePlaybookExecution | null> {
    const executions = await this.getExecutions();
    return executions.find(e => e.id === id) || null;
  }

  /**
   * Cancel a running execution
   */
  async cancelExecution(id: string): Promise<boolean> {
    console.log('Cancelling execution:', id);
    return true;
  }

  /**
   * Get inventory hosts
   */
  async getInventoryHosts(): Promise<AnsibleInventoryHost[]> {
    return [
      {
        name: 'odoo-prod-01',
        ip: '192.168.1.100',
        port: 22,
        user: 'root',
        groups: ['odoo', 'production'],
        variables: { odoo_version: '17.0' },
      },
      {
        name: 'odoo-test-01',
        ip: '192.168.1.101',
        port: 22,
        user: 'root',
        groups: ['odoo', 'testing'],
        variables: { odoo_version: '17.0' },
      },
      {
        name: 'odoo-dev-01',
        ip: '192.168.1.102',
        port: 22,
        user: 'root',
        groups: ['odoo', 'development'],
        variables: { odoo_version: '18.0' },
      },
      {
        name: 'runbot-server',
        ip: '192.168.1.110',
        port: 22,
        user: 'root',
        groups: ['runbot', 'ci-cd'],
        variables: { runbot_workers: '4' },
      },
    ];
  }

  /**
   * Get available Ansible roles
   */
  async getRoles(): Promise<AnsibleRole[]> {
    return [
      {
        name: 'odoo',
        description: 'Install and configure Odoo ERP',
        path: '/ansible/roles/odoo',
        tasks: ['install.yml', 'configure.yml', 'service.yml'],
        handlers: ['restart_odoo.yml'],
        defaults: {
          odoo_version: '17.0',
          odoo_user: 'odoo',
          odoo_workers: 4,
        },
        vars: {},
      },
      {
        name: 'postgresql',
        description: 'Install and configure PostgreSQL database',
        path: '/ansible/roles/postgresql',
        tasks: ['install.yml', 'configure.yml', 'users.yml'],
        handlers: ['restart_postgresql.yml'],
        defaults: {
          pg_version: '16',
          pg_max_connections: 200,
        },
        vars: {},
      },
      {
        name: 'nginx',
        description: 'Install and configure Nginx reverse proxy',
        path: '/ansible/roles/nginx',
        tasks: ['install.yml', 'configure.yml', 'ssl.yml'],
        handlers: ['reload_nginx.yml'],
        defaults: {
          nginx_worker_processes: 'auto',
          nginx_worker_connections: 1024,
        },
        vars: {},
      },
      {
        name: 'runbot',
        description: 'Install and configure Odoo Runbot CI/CD',
        path: '/ansible/roles/runbot',
        tasks: ['install.yml', 'configure.yml', 'workers.yml'],
        handlers: ['restart_runbot.yml'],
        defaults: {
          runbot_workers: 4,
          runbot_running_max: 10,
        },
        vars: {},
      },
    ];
  }

  /**
   * Validate playbook syntax
   */
  async validatePlaybook(
    playbookPath: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    console.log('Validating playbook:', playbookPath);
    return {
      valid: true,
      errors: [],
    };
  }

  /**
   * Test connection to hosts
   */
  async testConnection(hosts: string[]): Promise<Record<string, boolean>> {
    console.log('Testing connection to hosts:', hosts);
    const results: Record<string, boolean> = {};
    for (const host of hosts) {
      results[host] = true; // Mock: all connections successful
    }
    return results;
  }
}

export const ansibleService = new AnsibleService();
