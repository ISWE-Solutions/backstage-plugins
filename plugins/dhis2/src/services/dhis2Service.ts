import {
  DHIS2Instance,
  CreateInstanceRequest,
  OrchestrationLogEntry,
  ProxmoxNode,
  ProxmoxClusterSettings,
} from '../types';
import { settingsService } from './settingsService';

const MOCK_NODES: ProxmoxNode[] = [
  { node: 'pve1', status: 'online', cpu: 0.22, maxcpu: 16, mem: 12_884_901_888, maxmem: 68_719_476_736, disk: 53_687_091_200, maxdisk: 536_870_912_000 },
  { node: 'pve2', status: 'online', cpu: 0.14, maxcpu: 16, mem: 9_663_676_416, maxmem: 68_719_476_736, disk: 42_949_672_960, maxdisk: 536_870_912_000 },
  { node: 'pve3', status: 'online', cpu: 0.08, maxcpu: 16, mem: 5_368_709_120, maxmem: 68_719_476_736, disk: 34_359_738_368, maxdisk: 536_870_912_000 },
];

function buildProxmoxAuthHeader(s: ProxmoxClusterSettings): string | null {
  if (s.authMethod === 'token' && s.tokenId && s.tokenSecret) {
    return `PVEAPIToken=${s.tokenId}=${s.tokenSecret}`;
  }
  return null;
}

/**
 * Service for managing DHIS2 instances
 * This would typically connect to a backend API that handles Proxmox interactions
 */
export class DHIS2Service {
  constructor(_baseUrl: string = '/api/dhis2') {
    // baseUrl will be used when backend API is implemented
  }

  /**
   * Get all DHIS2 instances
   */
  async getInstances(): Promise<DHIS2Instance[]> {
    // Mock data for demonstration
    // In production, this would call your backend API
    return [
      {
        id: 'dhis2-001',
        name: 'DHIS2 Production',
        vmid: '100',
        node: 'pve1',
        status: 'running',
        version: '2.40.3',
        url: 'https://dhis2-prod.example.com',
        domain: 'dhis2-prod.example.com',
        database: {
          name: 'dhis2_prod',
          user: 'dhis2_user',
        },
        resources: {
          cpu: 4,
          memory: 8192,
          storage: 100,
        },
        created: '2026-01-15T10:00:00Z',
        updated: '2026-02-01T14:30:00Z',
      },
      {
        id: 'dhis2-002',
        name: 'DHIS2 Testing',
        vmid: '101',
        node: 'pve2',
        status: 'running',
        version: '2.40.3',
        url: 'https://dhis2-test.example.com',
        domain: 'dhis2-test.example.com',
        database: {
          name: 'dhis2_test',
          user: 'dhis2_user',
        },
        resources: {
          cpu: 2,
          memory: 4096,
          storage: 50,
        },
        created: '2026-01-20T09:00:00Z',
        updated: '2026-01-28T11:00:00Z',
      },
      {
        id: 'dhis2-003',
        name: 'DHIS2 Development',
        vmid: '102',
        node: 'pve1',
        status: 'stopped',
        version: '2.41.0',
        url: 'https://dhis2-dev.example.com',
        domain: 'dhis2-dev.example.com',
        database: {
          name: 'dhis2_dev',
          user: 'dhis2_user',
        },
        resources: {
          cpu: 2,
          memory: 4096,
          storage: 50,
        },
        created: '2026-01-25T15:00:00Z',
        updated: '2026-02-01T08:00:00Z',
      },
    ];
  }

  /**
   * Get a single DHIS2 instance by ID
   */
  async getInstance(id: string): Promise<DHIS2Instance | null> {
    const instances = await this.getInstances();
    return instances.find(i => i.id === id) || null;
  }

  /**
   * Create a new DHIS2 instance
   */
  async createInstance(request: CreateInstanceRequest): Promise<DHIS2Instance> {
    // In production, this would:
    // 1. Call Proxmox API to create LXC container
    // 2. Install and configure DHIS2
    // 3. Set up PostgreSQL database
    // 4. Configure Nginx reverse proxy
    // 5. Return the created instance

    console.log('Creating DHIS2 instance:', request);

    // Mock response
    return {
      id: `dhis2-${Date.now()}`,
      name: request.name,
      vmid: '103',
      node: request.node,
      status: 'provisioning',
      version: request.version,
      url: `https://${request.domain}`,
      domain: request.domain,
      database: {
        name: request.database.name,
        user: request.database.user,
      },
      resources: request.resources,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }

  /**
   * Start a DHIS2 instance
   */
  async startInstance(id: string): Promise<void> {
    console.log(`Starting instance ${id}`);
    // Call Proxmox API to start container
  }

  /**
   * Stop a DHIS2 instance
   */
  async stopInstance(id: string): Promise<void> {
    console.log(`Stopping instance ${id}`);
    // Call Proxmox API to stop container
  }

  /**
   * Restart a DHIS2 instance
   */
  async restartInstance(id: string): Promise<void> {
    console.log(`Restarting instance ${id}`);
    // Call Proxmox API to restart container
  }

  /**
   * Delete a DHIS2 instance
   */
  async deleteInstance(id: string): Promise<void> {
    console.log(`Deleting instance ${id}`);
    // In production:
    // 1. Stop container
    // 2. Remove Nginx configuration
    // 3. Drop database
    // 4. Delete LXC container
  }

  /**
   * Get available Proxmox nodes
   */
  /**
   * Get all Proxmox nodes in the cluster.
   *
   * Calls the Proxmox VE API (`GET /api2/json/nodes`) using the URL and API
   * token saved in the plugin Settings tab. Falls back to mock nodes if the
   * settings are incomplete or the request fails (e.g. CORS, network, bad
   * token) so the rest of the UI keeps working. For production, route this
   * call through the Backstage proxy backend to avoid CORS and to keep the
   * token off the browser.
   */
  async getNodes(
    overrideSettings?: ProxmoxClusterSettings,
  ): Promise<ProxmoxNode[]> {
    const result = await this.fetchNodes(overrideSettings);
    return result.nodes;
  }

  /**
   * Same as `getNodes()` but returns the data source and any error so the UI
   * can show meaningful feedback (e.g. when a Refresh click silently fell
   * back to mock data because the API is unreachable).
   */
  async fetchNodes(overrideSettings?: ProxmoxClusterSettings): Promise<{
    nodes: ProxmoxNode[];
    source: 'api' | 'mock';
    error?: string;
  }> {
    const proxmox = overrideSettings ?? settingsService.load().proxmox;

    // Determine target URL + headers. Prefer routing through the Backstage
    // backend proxy (configured in app-config.yaml under `proxy./proxmox`)
    // so the browser doesn't talk to Proxmox directly — this avoids CORS,
    // self-signed TLS and private-network reachability problems, and keeps
    // the API token off the client.
    let url: string;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (proxmox.useBackstageProxy) {
      if (!proxmox.backstageProxyPath) {
        const error =
          'Backstage proxy path is empty (e.g. /api/proxy/proxmox).';
        console.warn(`${error} Using mock nodes.`);
        return { nodes: MOCK_NODES, source: 'mock', error };
      }
      url = `${proxmox.backstageProxyPath.replace(
        /\/+$/,
        '',
      )}/api2/json/nodes`;
      // Auth header is injected by the backend proxy from env vars.
    } else {
      const auth = buildProxmoxAuthHeader(proxmox);
      if (!proxmox.apiUrl || !auth) {
        const error =
          'Proxmox API not fully configured (need API URL + API token).';
        console.warn(`${error} Using mock nodes.`);
        return { nodes: MOCK_NODES, source: 'mock', error };
      }
      url = `${proxmox.apiUrl.replace(/\/+$/, '')}/api2/json/nodes`;
      headers.Authorization = auth;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { data: ProxmoxNode[] };
      return { nodes: body.data ?? [], source: 'api' };
    } catch (err) {
      const error =
        err instanceof Error ? err.message : 'Unknown error fetching nodes';
      console.warn(
        'Failed to fetch Proxmox nodes, falling back to mock data:',
        err,
      );
      return { nodes: MOCK_NODES, source: 'mock', error };
    }
  }

  /**
   * Get available DHIS2 versions
   */
  async getVersions(): Promise<string[]> {
    return [
      '2.41.2',
      '2.41.1',
      '2.41.0',
      '2.40.5',
      '2.40.4',
      '2.40.3',
      '2.39.7',
    ];
  }

  /**
   * Get instance logs
   */
  async getInstanceLogs(_id: string, _lines: number = 100): Promise<string[]> {
    // Mock logs
    return [
      `[${new Date().toISOString()}] INFO: DHIS2 application started`,
      `[${new Date().toISOString()}] INFO: Database connection established`,
      `[${new Date().toISOString()}] INFO: Server listening on port 8080`,
    ];
  }

  /**
   * Update instance resources
   */
  async updateResources(
    id: string,
    resources: { cpu?: number; memory?: number; storage?: number },
  ): Promise<void> {
    console.log(`Updating resources for instance ${id}:`, resources);
    // Call Proxmox API to update container resources
  }

  /**
   * Get orchestration logs across all instances. In production this would
   * stream from a backend; for now we return mock entries that cover the
   * different log levels and actions the UI needs to render.
   */
  async getOrchestrationLogs(): Promise<OrchestrationLogEntry[]> {
    const now = Date.now();
    const t = (offsetSec: number) =>
      new Date(now - offsetSec * 1000).toISOString();

    return [
      {
        id: 'log-1001',
        timestamp: t(5),
        level: 'info',
        action: 'system',
        message: 'Orchestrator started, connected to Proxmox cluster (3 nodes online)',
        user: 'system',
      },
      {
        id: 'log-1002',
        timestamp: t(45),
        level: 'info',
        action: 'create-instance',
        message: 'Creating LXC container for DHIS2 instance "hmis-staging"',
        instanceId: 'dhis2-004',
        instanceName: 'hmis-staging',
        taskId: 'UPID:pve1:0000A1B2:0001C3D4:6657ABCD:vzcreate:104:root@pam:',
        user: 'admin',
      },
      {
        id: 'log-1003',
        timestamp: t(40),
        level: 'debug',
        action: 'proxmox-api',
        message: 'POST /nodes/pve1/lxc → 200 OK (vmid=104)',
        instanceId: 'dhis2-004',
        instanceName: 'hmis-staging',
      },
      {
        id: 'log-1004',
        timestamp: t(30),
        level: 'info',
        action: 'proxy-update',
        message: 'Wrote nginx site config /etc/nginx/conf.d/hmis-staging.conf and reloaded',
        instanceId: 'dhis2-004',
        instanceName: 'hmis-staging',
      },
      {
        id: 'log-1005',
        timestamp: t(120),
        level: 'info',
        action: 'start-instance',
        message: 'Container 100 started successfully',
        instanceId: 'dhis2-001',
        instanceName: 'DHIS2 Production',
        user: 'admin',
      },
      {
        id: 'log-1006',
        timestamp: t(360),
        level: 'warn',
        action: 'backup',
        message: 'Backup completed with warnings: 2 large tables exceeded the 30m budget',
        instanceId: 'dhis2-001',
        instanceName: 'DHIS2 Production',
        details: { sizeBytes: 5_872_402_944, durationSec: 1923 },
      },
      {
        id: 'log-1007',
        timestamp: t(900),
        level: 'error',
        action: 'restart-instance',
        message: 'Restart failed: tomcat did not bind to port 8080 within 90s',
        instanceId: 'dhis2-003',
        instanceName: 'DHIS2 Development',
        user: 'admin',
      },
      {
        id: 'log-1008',
        timestamp: t(1500),
        level: 'info',
        action: 'stop-instance',
        message: 'Container 102 stopped gracefully',
        instanceId: 'dhis2-003',
        instanceName: 'DHIS2 Development',
        user: 'admin',
      },
      {
        id: 'log-1009',
        timestamp: t(3600),
        level: 'info',
        action: 'update-resources',
        message: 'Resized container 101: cpu 2→4, memory 4096→8192MB',
        instanceId: 'dhis2-002',
        instanceName: 'DHIS2 Testing',
        user: 'admin',
      },
      {
        id: 'log-1010',
        timestamp: t(7200),
        level: 'debug',
        action: 'proxmox-api',
        message: 'GET /cluster/resources → 200 OK (cached 30s)',
      },
    ];
  }
}

export const dhis2Service = new DHIS2Service();
