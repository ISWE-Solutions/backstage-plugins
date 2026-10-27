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
    // Mock data - in production this would call the backend API
    return [
      {
        id: 'odoo-install',
        name: 'Odoo Installation',
        description: 'Install and configure Odoo on a fresh container',
        path: '/ansible/playbooks/odoo-install.yml',
        variables: {
          odoo_version: '18.0',
          odoo_edition: 'community',
          odoo_environment: 'staging',
          odoo_repo_url: 'https://github.com/odoo/odoo.git',
          odoo_repo_rev: '18.0',
          odoo_addons_repos: [],
          odoo_install_postgresql: false,
          odoo_config_workers: 4,
          odoo_config_list_db: false,
          odoo_config_dbfilter: '^%d$',
          install_wkhtmltopdf: true,
        },
        tags: ['install', 'odoo', 'postgresql'],
        created: '2026-01-10T10:00:00Z',
        updated: '2026-02-01T14:30:00Z',
      },
      {
        id: 'odoo-configure',
        name: 'Odoo Configuration',
        description: 'Configure existing Odoo instance settings',
        path: '/ansible/playbooks/odoo-configure.yml',
        variables: {
          odoo_config_path: '/etc/odoo/odoo.conf',
          odoo_data_dir: '/var/lib/odoo',
        },
        tags: ['configure', 'odoo'],
        created: '2026-01-12T08:00:00Z',
        updated: '2026-01-28T11:00:00Z',
      },
      {
        id: 'odoo-backup',
        name: 'Odoo Backup',
        description: 'Backup Odoo database and filestore',
        path: '/ansible/playbooks/odoo-backup.yml',
        variables: {
          backup_path: '/backups/odoo',
          backup_retention_days: 30,
        },
        tags: ['backup', 'maintenance'],
        created: '2026-01-15T12:00:00Z',
        updated: '2026-01-20T09:00:00Z',
      },
      {
        id: 'odoo-restore',
        name: 'Odoo Restore',
        description: 'Restore Odoo from backup',
        path: '/ansible/playbooks/odoo-restore.yml',
        variables: {
          backup_file: '',
          restore_filestore: true,
        },
        tags: ['restore', 'maintenance'],
        created: '2026-01-15T12:30:00Z',
        updated: '2026-01-20T09:30:00Z',
      },
      {
        id: 'odoo-upgrade',
        name: 'Odoo Upgrade',
        description: 'Upgrade Odoo to a newer version',
        path: '/ansible/playbooks/odoo-upgrade.yml',
        variables: {
          target_version: '17.0',
          backup_before_upgrade: true,
        },
        tags: ['upgrade', 'maintenance'],
        created: '2026-01-18T10:00:00Z',
        updated: '2026-02-05T16:00:00Z',
      },
      {
        id: 'runbot-setup',
        name: 'Runbot Setup',
        description: 'Install and configure Odoo Runbot for CI/CD',
        path: '/ansible/playbooks/runbot-setup.yml',
        variables: {
          runbot_workers: 4,
          runbot_running_max: 10,
          nginx_enabled: true,
        },
        tags: ['runbot', 'ci-cd', 'install'],
        created: '2026-01-20T14:00:00Z',
        updated: '2026-02-03T11:00:00Z',
      },
      {
        id: 'nginx-proxy',
        name: 'Nginx Reverse Proxy',
        description: 'Setup Nginx as reverse proxy for Odoo',
        path: '/ansible/playbooks/nginx-proxy.yml',
        variables: {
          ssl_enabled: true,
          ssl_certificate_path: '/etc/ssl/certs',
          upstream_port: 8069,
          longpolling_port: 8072,
        },
        tags: ['nginx', 'proxy', 'ssl'],
        created: '2026-01-22T09:00:00Z',
        updated: '2026-01-30T15:00:00Z',
      },
      {
        id: 'postgresql-setup',
        name: 'PostgreSQL Setup',
        description: 'Install and configure PostgreSQL for Odoo',
        path: '/ansible/playbooks/postgresql-setup.yml',
        variables: {
          pg_version: '16',
          pg_max_connections: 200,
          shared_buffers: '2GB',
        },
        tags: ['postgresql', 'database', 'install'],
        created: '2026-01-08T10:00:00Z',
        updated: '2026-01-25T12:00:00Z',
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
        playbook_name: 'Odoo Installation',
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
        playbook_id: 'runbot-setup',
        playbook_name: 'Runbot Setup',
        status: 'success',
        target_hosts: ['runbot-server'],
        extra_vars: { runbot_workers: 4 },
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
        playbook_name: 'Odoo Backup',
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
