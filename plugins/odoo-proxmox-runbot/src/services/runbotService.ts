import {
  RunbotRepo,
  RunbotBranch,
  RunbotBuild,
  RunbotBuildLog,
  RunbotConfig,
} from '../types';

/**
 * Service for interacting with Odoo Runbot
 * Manages CI/CD builds and testing for Odoo modules
 */
export class RunbotService {
  /**
   * Get all configured repositories
   */
  async getRepos(): Promise<RunbotRepo[]> {
    return [
      {
        id: 1,
        name: 'odoo/odoo',
        url: 'https://github.com/odoo/odoo.git',
        branch_ids: [1, 2, 3],
        active: true,
        modules: '*',
        server_files: 'odoo-bin',
        addons_paths: 'addons,odoo/addons',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-02-08T10:00:00Z',
      },
      {
        id: 2,
        name: 'odoo/enterprise',
        url: 'https://github.com/odoo/enterprise.git',
        branch_ids: [4, 5, 6],
        active: true,
        modules: '*',
        server_files: '',
        addons_paths: '',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-02-08T10:00:00Z',
      },
      {
        id: 3,
        name: 'custom/addons',
        url: 'https://github.com/yourorg/custom-addons.git',
        branch_ids: [7, 8],
        active: true,
        modules: 'custom_module_1,custom_module_2',
        server_files: '',
        addons_paths: '',
        created: '2026-01-15T00:00:00Z',
        updated: '2026-02-07T14:00:00Z',
      },
    ];
  }

  /**
   * Get a specific repository
   */
  async getRepo(id: number): Promise<RunbotRepo | null> {
    const repos = await this.getRepos();
    return repos.find(r => r.id === id) || null;
  }

  /**
   * Create a new repository
   */
  async createRepo(repo: Partial<RunbotRepo>): Promise<RunbotRepo> {
    console.log('Creating repository:', repo);
    return {
      id: Date.now(),
      name: repo.name || '',
      url: repo.url || '',
      branch_ids: [],
      active: true,
      modules: repo.modules || '*',
      server_files: repo.server_files || '',
      addons_paths: repo.addons_paths || '',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }

  /**
   * Update a repository
   */
  async updateRepo(
    id: number,
    updates: Partial<RunbotRepo>,
  ): Promise<RunbotRepo | null> {
    console.log('Updating repository:', { id, updates });
    const repo = await this.getRepo(id);
    if (!repo) return null;
    return { ...repo, ...updates, updated: new Date().toISOString() };
  }

  /**
   * Delete a repository
   */
  async deleteRepo(id: number): Promise<boolean> {
    console.log('Deleting repository:', id);
    return true;
  }

  /**
   * Get all branches
   */
  async getBranches(): Promise<RunbotBranch[]> {
    return [
      {
        id: 1,
        name: '17.0',
        repo_id: 1,
        repo_name: 'odoo/odoo',
        sticky: true,
        coverage: true,
        state: 'done',
        last_build_id: 1001,
        build_count: 234,
        job_type: 'all',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-02-08T10:00:00Z',
      },
      {
        id: 2,
        name: '16.0',
        repo_id: 1,
        repo_name: 'odoo/odoo',
        sticky: true,
        coverage: true,
        state: 'done',
        last_build_id: 1002,
        build_count: 456,
        job_type: 'all',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-02-07T22:00:00Z',
      },
      {
        id: 3,
        name: 'master',
        repo_id: 1,
        repo_name: 'odoo/odoo',
        sticky: false,
        coverage: true,
        state: 'running',
        last_build_id: 1003,
        build_count: 89,
        job_type: 'all',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-02-08T11:30:00Z',
      },
      {
        id: 7,
        name: 'main',
        repo_id: 3,
        repo_name: 'custom/addons',
        sticky: true,
        coverage: true,
        state: 'done',
        last_build_id: 1004,
        build_count: 45,
        job_type: 'all',
        created: '2026-01-15T00:00:00Z',
        updated: '2026-02-08T09:00:00Z',
      },
      {
        id: 8,
        name: 'develop',
        repo_id: 3,
        repo_name: 'custom/addons',
        sticky: false,
        coverage: true,
        state: 'pending',
        last_build_id: 1005,
        build_count: 23,
        job_type: 'all',
        created: '2026-01-15T00:00:00Z',
        updated: '2026-02-08T11:45:00Z',
      },
    ];
  }

  /**
   * Get branches for a specific repository
   */
  async getRepoBranches(repoId: number): Promise<RunbotBranch[]> {
    const branches = await this.getBranches();
    return branches.filter(b => b.repo_id === repoId);
  }

  /**
   * Get a specific branch
   */
  async getBranch(id: number): Promise<RunbotBranch | null> {
    const branches = await this.getBranches();
    return branches.find(b => b.id === id) || null;
  }

  /**
   * Get all builds
   */
  async getBuilds(): Promise<RunbotBuild[]> {
    return [
      {
        id: 1001,
        branch_id: 1,
        branch_name: '17.0',
        repo_name: 'odoo/odoo',
        commit: 'a1b2c3d4e5f6789012345678901234567890abcd',
        commit_message: 'Fix inventory valuation regression',
        author: 'developer@odoo.com',
        state: 'done',
        result: 'ok',
        host: 'runbot-01',
        port: 8069,
        dest: 'build-1001',
        sequence: 1001,
        job: 'all',
        job_start: '2026-02-08T08:00:00Z',
        job_end: '2026-02-08T09:30:00Z',
        duration: 5400,
        coverage_result: 85.5,
        build_start: '2026-02-08T08:00:00Z',
        build_end: '2026-02-08T09:30:00Z',
        log_ids: [1, 2, 3],
        created: '2026-02-08T07:55:00Z',
      },
      {
        id: 1002,
        branch_id: 2,
        branch_name: '16.0',
        repo_name: 'odoo/odoo',
        commit: 'b2c3d4e5f678901234567890123456789012bcde',
        commit_message: 'Backport security fix',
        author: 'security@odoo.com',
        state: 'done',
        result: 'ok',
        host: 'runbot-02',
        port: 8069,
        dest: 'build-1002',
        sequence: 1002,
        job: 'all',
        job_start: '2026-02-07T20:00:00Z',
        job_end: '2026-02-07T21:45:00Z',
        duration: 6300,
        coverage_result: 87.2,
        build_start: '2026-02-07T20:00:00Z',
        build_end: '2026-02-07T21:45:00Z',
        log_ids: [4, 5],
        created: '2026-02-07T19:55:00Z',
      },
      {
        id: 1003,
        branch_id: 3,
        branch_name: 'master',
        repo_name: 'odoo/odoo',
        commit: 'c3d4e5f67890123456789012345678901234cdef',
        commit_message: 'WIP: New feature development',
        author: 'dev@odoo.com',
        state: 'testing',
        result: 'ok',
        host: 'runbot-01',
        port: 8070,
        dest: 'build-1003',
        sequence: 1003,
        job: 'testing',
        job_start: '2026-02-08T11:00:00Z',
        duration: 1800,
        build_start: '2026-02-08T11:00:00Z',
        log_ids: [6],
        created: '2026-02-08T10:55:00Z',
      },
      {
        id: 1004,
        branch_id: 7,
        branch_name: 'main',
        repo_name: 'custom/addons',
        commit: 'd4e5f678901234567890123456789012345defgh',
        commit_message: 'Add custom invoice report',
        author: 'customdev@company.com',
        state: 'done',
        result: 'ok',
        host: 'runbot-02',
        port: 8071,
        dest: 'build-1004',
        sequence: 1004,
        job: 'all',
        job_start: '2026-02-08T07:00:00Z',
        job_end: '2026-02-08T07:45:00Z',
        duration: 2700,
        coverage_result: 92.1,
        build_start: '2026-02-08T07:00:00Z',
        build_end: '2026-02-08T07:45:00Z',
        log_ids: [7, 8],
        created: '2026-02-08T06:55:00Z',
      },
      {
        id: 1005,
        branch_id: 8,
        branch_name: 'develop',
        repo_name: 'custom/addons',
        commit: 'e5f6789012345678901234567890123456efghij',
        commit_message: 'Fix unit tests',
        author: 'customdev@company.com',
        state: 'pending',
        result: 'ok',
        host: '',
        port: 0,
        dest: 'build-1005',
        sequence: 1005,
        job: '',
        job_start: '',
        duration: 0,
        build_start: '',
        log_ids: [],
        created: '2026-02-08T11:40:00Z',
      },
      {
        id: 1000,
        branch_id: 1,
        branch_name: '17.0',
        repo_name: 'odoo/odoo',
        commit: '9876543210abcdef9876543210abcdef98765432',
        commit_message: 'Broken: Test failure example',
        author: 'developer@odoo.com',
        state: 'done',
        result: 'ko',
        host: 'runbot-01',
        port: 8072,
        dest: 'build-1000',
        sequence: 1000,
        job: 'all',
        job_start: '2026-02-07T14:00:00Z',
        job_end: '2026-02-07T15:30:00Z',
        duration: 5400,
        error_summary: 'Test test_stock_valuation failed: AssertionError',
        build_start: '2026-02-07T14:00:00Z',
        build_end: '2026-02-07T15:30:00Z',
        log_ids: [9, 10, 11],
        created: '2026-02-07T13:55:00Z',
      },
    ];
  }

  /**
   * Get builds for a specific branch
   */
  async getBranchBuilds(branchId: number): Promise<RunbotBuild[]> {
    const builds = await this.getBuilds();
    return builds.filter(b => b.branch_id === branchId);
  }

  /**
   * Get a specific build
   */
  async getBuild(id: number): Promise<RunbotBuild | null> {
    const builds = await this.getBuilds();
    return builds.find(b => b.id === id) || null;
  }

  /**
   * Trigger a new build
   */
  async triggerBuild(branchId: number): Promise<RunbotBuild> {
    console.log('Triggering build for branch:', branchId);
    const branch = await this.getBranch(branchId);

    return {
      id: Date.now(),
      branch_id: branchId,
      branch_name: branch?.name || 'unknown',
      repo_name: branch?.repo_name || 'unknown',
      commit: 'pending',
      commit_message: 'Manual trigger',
      author: 'system',
      state: 'pending',
      result: 'ok',
      host: '',
      port: 0,
      dest: `build-${Date.now()}`,
      sequence: Date.now(),
      job: '',
      job_start: '',
      duration: 0,
      build_start: '',
      log_ids: [],
      created: new Date().toISOString(),
    };
  }

  /**
   * Kill a build
   */
  async killBuild(id: number): Promise<boolean> {
    console.log('Killing build:', id);
    return true;
  }

  /**
   * Rebuild a failed build
   */
  async rebuildBuild(id: number): Promise<RunbotBuild> {
    console.log('Rebuilding build:', id);
    const original = await this.getBuild(id);

    return {
      id: Date.now(),
      branch_id: original?.branch_id || 0,
      branch_name: original?.branch_name || 'unknown',
      repo_name: original?.repo_name || 'unknown',
      commit: original?.commit || 'unknown',
      commit_message: original?.commit_message || 'Rebuild',
      author: original?.author || 'system',
      state: 'pending',
      result: 'ok',
      host: '',
      port: 0,
      dest: `build-${Date.now()}`,
      sequence: Date.now(),
      job: '',
      job_start: '',
      duration: 0,
      build_start: '',
      log_ids: [],
      created: new Date().toISOString(),
    };
  }

  /**
   * Get build logs
   */
  async getBuildLogs(buildId: number): Promise<RunbotBuildLog[]> {
    console.log('Getting logs for build:', buildId);
    return [
      {
        id: 1,
        build_id: buildId,
        level: 'info',
        type: 'server',
        name: 'odoo.modules.loading',
        path: '/odoo/addons',
        message: 'Loading module: sale',
        timestamp: '2026-02-08T08:05:00Z',
      },
      {
        id: 2,
        build_id: buildId,
        level: 'info',
        type: 'server',
        name: 'odoo.modules.loading',
        path: '/odoo/addons',
        message: 'Loading module: stock',
        timestamp: '2026-02-08T08:06:00Z',
      },
      {
        id: 3,
        build_id: buildId,
        level: 'info',
        type: 'test',
        name: 'odoo.tests',
        path: '/odoo/addons/sale/tests',
        message: 'Running tests for module: sale',
        timestamp: '2026-02-08T08:30:00Z',
      },
    ];
  }

  /**
   * Get Runbot configuration
   */
  async getConfig(): Promise<RunbotConfig> {
    return {
      workers: 4,
      running_max: 10,
      job_timeout: 3600,
      build_timeout: 7200,
      default_host: 'runbot.example.com',
      nginx_enabled: true,
    };
  }

  /**
   * Update Runbot configuration
   */
  async updateConfig(config: Partial<RunbotConfig>): Promise<RunbotConfig> {
    console.log('Updating Runbot config:', config);
    const current = await this.getConfig();
    return { ...current, ...config };
  }

  /**
   * Get build statistics
   */
  async getStats(): Promise<{
    totalBuilds: number;
    successfulBuilds: number;
    failedBuilds: number;
    pendingBuilds: number;
    runningBuilds: number;
    averageDuration: number;
    averageCoverage: number;
  }> {
    const builds = await this.getBuilds();

    const successful = builds.filter(
      b => b.result === 'ok' && b.state === 'done',
    ).length;
    const failed = builds.filter(b => b.result === 'ko').length;
    const pending = builds.filter(b => b.state === 'pending').length;
    const running = builds.filter(
      b => b.state === 'testing' || b.state === 'running',
    ).length;

    const completedBuilds = builds.filter(
      b => b.state === 'done' && b.duration > 0,
    );
    const avgDuration =
      completedBuilds.length > 0
        ? completedBuilds.reduce((sum, b) => sum + b.duration, 0) /
          completedBuilds.length
        : 0;

    const buildsWithCoverage = builds.filter(
      b => b.coverage_result !== undefined,
    );
    const avgCoverage =
      buildsWithCoverage.length > 0
        ? buildsWithCoverage.reduce(
            (sum, b) => sum + (b.coverage_result || 0),
            0,
          ) / buildsWithCoverage.length
        : 0;

    return {
      totalBuilds: builds.length,
      successfulBuilds: successful,
      failedBuilds: failed,
      pendingBuilds: pending,
      runningBuilds: running,
      averageDuration: avgDuration,
      averageCoverage: avgCoverage,
    };
  }
}

export const runbotService = new RunbotService();
