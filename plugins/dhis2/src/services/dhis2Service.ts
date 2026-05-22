import {
  DHIS2Instance,
  CreateInstanceRequest,
  OrchestrationLogEntry,
  ProxmoxNode,
  ProxmoxStorage,
  ClusterContainer,
  ProxmoxClusterSettings,
} from '../types';
import { settingsService } from './settingsService';

/**
 * Wrap `fetch` so transient "Service has not started up yet" responses from
 * Backstage's backend lifecycle middleware (HTTP 503) are retried with
 * exponential backoff instead of bubbling up as user-facing errors during
 * cold start.
 */
async function fetchWithLifecycleRetry(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { retries?: number; initialDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 20; // ~ up to ~60s total with backoff
  const initialDelayMs = opts.initialDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchFn(input, init);
    if (res.status !== 503) return res;
    // Only retry the well-known startup race; pass other 503s straight back.
    let isStartup = false;
    try {
      const cloned = res.clone();
      const body = await cloned.json();
      const message =
        (typeof body?.error === 'string' && body.error) ||
        body?.error?.message ||
        body?.message ||
        '';
      if (typeof message === 'string' && /has not started up yet/i.test(message)) {
        isStartup = true;
      }
    } catch {
      // Body wasn't JSON; fall through and surface the 503.
    }
    if (!isStartup || attempt === retries) return res;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(maxDelayMs, Math.round(delay * 1.5));
  }
  // Unreachable, but satisfies the type checker.
  return fetchFn(input, init);
}

const MOCK_NODES: ProxmoxNode[] = [
  { node: 'pve1', status: 'online', cpu: 0.22, maxcpu: 16, mem: 12_884_901_888, maxmem: 68_719_476_736, disk: 53_687_091_200, maxdisk: 536_870_912_000 },
  { node: 'pve2', status: 'online', cpu: 0.14, maxcpu: 16, mem: 9_663_676_416, maxmem: 68_719_476_736, disk: 42_949_672_960, maxdisk: 536_870_912_000 },
  { node: 'pve3', status: 'online', cpu: 0.08, maxcpu: 16, mem: 5_368_709_120, maxmem: 68_719_476_736, disk: 34_359_738_368, maxdisk: 536_870_912_000 },
];

const MOCK_STORAGES: ProxmoxStorage[] = [
  { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', active: 1, enabled: 1 },
  { storage: 'local-lvm', type: 'lvmthin', content: 'rootdir,images', active: 1, enabled: 1 },
];

const MOCK_CONTAINERS: ClusterContainer[] = [
  { vmid: 100, name: 'dhis2-prod', node: 'pve1', status: 'running', type: 'lxc', cpu: 0.12, maxcpu: 4, mem: 4_294_967_296, maxmem: 8_589_934_592, disk: 21_474_836_480, maxdisk: 107_374_182_400, uptime: 432_000 },
  { vmid: 101, name: 'dhis2-test', node: 'pve2', status: 'running', type: 'lxc', cpu: 0.05, maxcpu: 2, mem: 2_147_483_648, maxmem: 4_294_967_296, disk: 10_737_418_240, maxdisk: 53_687_091_200, uptime: 86_400 },
  { vmid: 102, name: 'dhis2-dev', node: 'pve1', status: 'stopped', type: 'lxc', cpu: 0, maxcpu: 2, mem: 0, maxmem: 4_294_967_296, disk: 0, maxdisk: 53_687_091_200, uptime: 0 },
  { vmid: 110, name: 'nginx-proxy', node: 'pve3', status: 'running', type: 'lxc', cpu: 0.02, maxcpu: 2, mem: 536_870_912, maxmem: 2_147_483_648, disk: 2_147_483_648, maxdisk: 21_474_836_480, uptime: 864_000 },
];

const MOCK_VMS: ClusterContainer[] = [
  { vmid: 200, name: 'postgres-prod', node: 'pve1', status: 'running', type: 'qemu', cpu: 0.18, maxcpu: 8, mem: 17_179_869_184, maxmem: 34_359_738_368, disk: 0, maxdisk: 214_748_364_800, uptime: 1_209_600 },
  { vmid: 201, name: 'observability', node: 'pve2', status: 'running', type: 'qemu', cpu: 0.09, maxcpu: 4, mem: 8_589_934_592, maxmem: 17_179_869_184, disk: 0, maxdisk: 107_374_182_400, uptime: 604_800 },
  { vmid: 202, name: 'gitlab-runner', node: 'pve3', status: 'stopped', type: 'qemu', cpu: 0, maxcpu: 4, mem: 0, maxmem: 8_589_934_592, disk: 0, maxdisk: 53_687_091_200, uptime: 0 },
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
    fetchFn?: typeof fetch,
  ): Promise<ProxmoxNode[]> {
    const result = await this.fetchNodes(overrideSettings, fetchFn);
    return result.nodes;
  }

  /**
   * Same as `getNodes()` but returns the data source and any error so the UI
   * can show meaningful feedback (e.g. when a Refresh click silently fell
   * back to mock data because the API is unreachable).
   */
  async fetchNodes(
    overrideSettings?: ProxmoxClusterSettings,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    nodes: ProxmoxNode[];
    source: 'api' | 'mock';
    error?: string;
    url?: string;
    status?: number;
    statusText?: string;
    bodySample?: string;
    durationMs?: number;
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
        return { nodes: MOCK_NODES, source: 'mock', error, url: proxmox.apiUrl };
      }
      url = `${proxmox.apiUrl.replace(/\/+$/, '')}/api2/json/nodes`;
      headers.Authorization = auth;
    }

    const started = performance.now();
    let res: Response | undefined;
    let rawBody = '';
    try {
      res = await fetchFn(url, { headers });
      rawBody = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      let parsed: { data?: ProxmoxNode[] } = {};
      try {
        parsed = JSON.parse(rawBody);
      } catch (e) {
        throw new Error(
          `Response was not valid JSON: ${(e as Error).message}`,
        );
      }
      const durationMs = Math.round(performance.now() - started);
      console.info(
        `[dhis2] fetched ${parsed.data?.length ?? 0} Proxmox node(s) from ${url} in ${durationMs}ms`,
      );
      return {
        nodes: parsed.data ?? [],
        source: 'api',
        url,
        status: res.status,
        statusText: res.statusText,
        durationMs,
        bodySample: rawBody.slice(0, 500),
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      const error =
        err instanceof Error ? err.message : 'Unknown error fetching nodes';
      console.error(
        `[dhis2] Failed to fetch Proxmox nodes from ${url} after ${durationMs}ms: ${error}`,
        { url, status: res?.status, body: rawBody.slice(0, 1000), err },
      );
      return {
        nodes: MOCK_NODES,
        source: 'mock',
        error,
        url,
        status: res?.status,
        statusText: res?.statusText,
        durationMs,
        bodySample: rawBody.slice(0, 500),
      };
    }
  }

  /**
   * Fetch the list of storages configured on a given Proxmox node.
   * Falls back to a small mock list when the API is not reachable so the UI
   * still shows something meaningful (e.g. "local", "local-lvm").
   */
  async fetchNodeStorage(
    node: string,
    overrideSettings?: ProxmoxClusterSettings,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<ProxmoxStorage[]> {
    const proxmox = overrideSettings ?? settingsService.load().proxmox;

    let url: string;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (proxmox.useBackstageProxy) {
      if (!proxmox.backstageProxyPath) return MOCK_STORAGES;
      url = `${proxmox.backstageProxyPath.replace(/\/+$/, '')}/api2/json/nodes/${encodeURIComponent(node)}/storage`;
    } else {
      const auth = buildProxmoxAuthHeader(proxmox);
      if (!proxmox.apiUrl || !auth) return MOCK_STORAGES;
      url = `${proxmox.apiUrl.replace(/\/+$/, '')}/api2/json/nodes/${encodeURIComponent(node)}/storage`;
      headers.Authorization = auth;
    }

    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const parsed: { data?: ProxmoxStorage[] } = await res.json();
      return parsed.data ?? [];
    } catch (err) {
      console.warn(
        `[dhis2] Failed to fetch storages for node ${node} from ${url}: ${
          (err as Error).message
        }. Using mock storages.`,
      );
      return MOCK_STORAGES;
    }
  }

  /**
   * Fetch cluster resources of the given kind ('lxc' or 'qemu') across the
   * cluster via `GET /api2/json/cluster/resources?type=vm`. Falls back to a
   * small mock list when the API is unreachable.
   */
  private async fetchClusterResources(
    kind: 'lxc' | 'qemu',
    overrideSettings?: ProxmoxClusterSettings,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    items: ClusterContainer[];
    source: 'api' | 'mock';
    error?: string;
  }> {
    const proxmox = overrideSettings ?? settingsService.load().proxmox;
    const mock = kind === 'lxc' ? MOCK_CONTAINERS : MOCK_VMS;

    let url: string;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (proxmox.useBackstageProxy) {
      if (!proxmox.backstageProxyPath) {
        return {
          items: mock,
          source: 'mock',
          error: 'Backstage proxy path is empty.',
        };
      }
      url = `${proxmox.backstageProxyPath.replace(
        /\/+$/,
        '',
      )}/api2/json/cluster/resources?type=vm`;
    } else {
      const auth = buildProxmoxAuthHeader(proxmox);
      if (!proxmox.apiUrl || !auth) {
        return {
          items: mock,
          source: 'mock',
          error: 'Proxmox API not fully configured.',
        };
      }
      url = `${proxmox.apiUrl.replace(
        /\/+$/,
        '',
      )}/api2/json/cluster/resources?type=vm`;
      headers.Authorization = auth;
    }

    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const parsed: { data?: ClusterContainer[] } = await res.json();
      const items = (parsed.data ?? []).filter(c => c.type === kind);
      return { items, source: 'api' };
    } catch (err) {
      const error = (err as Error).message;
      console.warn(
        `[dhis2] Failed to fetch cluster ${kind} resources from ${url}: ${error}. Using mock data.`,
      );
      return { items: mock, source: 'mock', error };
    }
  }

  /**
   * Fetch all LXC containers across the cluster.
   */
  async fetchClusterContainers(
    overrideSettings?: ProxmoxClusterSettings,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    containers: ClusterContainer[];
    source: 'api' | 'mock';
    error?: string;
  }> {
    const result = await this.fetchClusterResources(
      'lxc',
      overrideSettings,
      fetchFn,
    );
    return {
      containers: result.items,
      source: result.source,
      error: result.error,
    };
  }

  /**
   * Fetch all QEMU virtual machines across the cluster.
   */
  async fetchClusterVMs(
    overrideSettings?: ProxmoxClusterSettings,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    vms: ClusterContainer[];
    source: 'api' | 'mock';
    error?: string;
  }> {
    const result = await this.fetchClusterResources(
      'qemu',
      overrideSettings,
      fetchFn,
    );
    return { vms: result.items, source: result.source, error: result.error };
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
   * List databases on an existing PostgreSQL server using the provided
   * credentials. Used by the Create dialog when "Connect to an existing
   * database" is enabled so the user can pick a database instead of typing
   * its name.
   *
   * Calls the `@internal/plugin-dhis2-backend` endpoint
   * `POST <baseUrl>/databases/list` which opens a short-lived PG connection
   * and runs:
   *   SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1
   *
   * The caller must resolve `baseUrl` via `discoveryApi.getBaseUrl('dhis2')`
   * and pass `fetchApi.fetch` so the request carries the Backstage auth
   * token. Throws an `Error` with a user-facing message on failure.
   */
  async listDatabases(
    params: {
      host: string;
      port: number;
      user: string;
      password: string;
    },
    baseUrl: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<string[]> {
    const url = `${baseUrl.replace(/\/+$/, '')}/databases/list`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new Error(
        `Unable to reach DHIS2 backend at ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const text = await res.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // fall through with raw text below
    }
    if (!res.ok) {
      const message =
        (body && (body.error || body.message)) ||
        text ||
        `HTTP ${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    if (!body || !Array.isArray(body.databases)) {
      throw new Error('Unexpected response from DHIS2 backend');
    }
    return body.databases as string[];
  }

  /**
   * Test connectivity to a PostgreSQL server using the credentials typed
   * into the Create dialog. Returns a structured result so the UI can
   * render an Alert with the server version or a precise error message.
   *
   * Backed by `POST <baseUrl>/databases/test`.
   */
  async testDatabaseConnection(
    params: {
      host: string;
      port: number;
      user: string;
      password: string;
    },
    baseUrl: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    ok: boolean;
    message: string;
    serverVersion?: string;
    code?: string;
    durationMs?: number;
  }> {
    const url = `${baseUrl.replace(/\/+$/, '')}/databases/test`;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const text = await res.text();
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        // fall through
      }
      if (!res.ok && typeof body?.ok !== 'boolean') {
        return {
          ok: false,
          message:
            (body && (body.error || body.message)) ||
            text ||
            `HTTP ${res.status} ${res.statusText}`,
        };
      }
      return {
        ok: Boolean(body.ok),
        message: body.message ?? (body.ok ? 'Connected' : 'Connection failed'),
        serverVersion: body.serverVersion,
        code: body.code,
        durationMs: body.durationMs,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Unable to reach DHIS2 backend at ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
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
   * Apply an edit to an existing instance (rename, change version, resize).
   * In production this should fan out to the relevant orchestrator steps
   * (Proxmox resize, DHIS2 redeploy/upgrade, rename DNS, etc.).
   */
  async updateInstance(
    id: string,
    patch: {
      name?: string;
      version?: string;
      resources?: Partial<{ cpu: number; memory: number; storage: number }>;
      database?: Partial<{
        name: string;
        user: string;
        host: string;
        port: number;
        password: string;
      }>;
    },
  ): Promise<void> {
    console.log(`Updating instance ${id}`, patch);
  }

  /**
   * Trigger an on-demand backup for an instance. Returns the ISO timestamp
   * of the new backup. In production this would invoke the dhis2-backend
   * backup job and stream progress; here we return immediately.
   */
  async backupInstance(id: string): Promise<{ timestamp: string }> {
    console.log(`Triggering backup for instance ${id}`);
    return { timestamp: new Date().toISOString() };
  }

  /**
   * Refresh status for a single instance from the orchestrator. The default
   * implementation re-fetches the full list and returns the matching entry.
   */
  async refreshInstance(id: string): Promise<DHIS2Instance | null> {
    return this.getInstance(id);
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

  // ---------------------------------------------------------------------
  // Real provisioning (dhis2-backend)
  // ---------------------------------------------------------------------

  /**
   * Start a real provisioning job on the backend. Returns the job id; the
   * caller should poll `getProvisionJob(jobId)` for progress updates.
   *
   * `baseUrl` must be resolved via `discoveryApi.getBaseUrl('dhis2')`.
   */
  async startProvisionJob(
    baseUrl: string,
    payload: ProvisionInstancePayload,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{ jobId: string; status: string }> {
    const res = await fetchWithLifecycleRetry(
      fetchFn,
      `${baseUrl}/instances/provision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      let msg = `Provision request failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        // Backstage's default error handler returns `{ error: { message } }`,
        // while our backend returns `{ error: string }`. Handle both, and
        // never fall through to `String(obj)` which yields "[object Object]".
        const err = body?.error;
        if (typeof err === 'string' && err.trim()) {
          msg = err;
        } else if (err && typeof err === 'object') {
          if (typeof err.message === 'string' && err.message.trim()) {
            msg = err.message;
          } else if (typeof err.name === 'string' && err.name.trim()) {
            msg = err.name;
          }
        } else if (typeof body?.message === 'string' && body.message.trim()) {
          msg = body.message;
        }
      } catch {
        // ignore body parse failure
      }
      throw new Error(msg);
    }
    return (await res.json()) as { jobId: string; status: string };
  }

  /**
   * Snapshot a running or completed provisioning job.
   */
  async getProvisionJob(
    baseUrl: string,
    jobId: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<ProvisionJobSnapshot> {
    const res = await fetchWithLifecycleRetry(
      fetchFn,
      `${baseUrl}/instances/jobs/${encodeURIComponent(jobId)}`,
    );
    if (!res.ok) {
      throw new Error(`Failed to load job (HTTP ${res.status})`);
    }
    return (await res.json()) as ProvisionJobSnapshot;
  }

  /**
   * List instances actually persisted by the backend (i.e. ones for which
   * provisioning succeeded). Returns an empty array if the backend has no
   * orchestrator state file configured.
   */
  async getPersistedInstances(
    baseUrl: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<DHIS2Instance[]> {
    const res = await fetchFn(`${baseUrl}/instances`);
    if (!res.ok) return [];
    const body = (await res.json()) as { instances?: DHIS2Instance[] };
    return body.instances ?? [];
  }

  /**
   * Fetch a reconciliation report comparing the backend's registry of
   * instances against the live Proxmox cluster. Used by the Instances
   * page to surface drift (untagged LXCs, missing LXCs, or unmanaged
   * DHIS2 containers created outside the plugin).
   */
  async getInstanceReconciliation(
    baseUrl: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{
    unmanaged: Array<{
      vmid: number;
      node: string;
      name?: string;
      tags?: string;
      status?: string;
    }>;
    orphans: DHIS2Instance[];
    untagged: DHIS2Instance[];
    proxmoxReachable: boolean;
    unreachableReason?: string;
  }> {
    const res = await fetchFn(
      `${baseUrl.replace(/\/+$/, '')}/instances/reconcile`,
    );
    if (!res.ok) {
      return {
        unmanaged: [],
        orphans: [],
        untagged: [],
        proxmoxReachable: false,
        unreachableReason: `Reconcile request failed (HTTP ${res.status})`,
      };
    }
    return res.json();
  }

  /**
   * Start a database transfer job that streams the source instance's
   * database (via pg_dump) into the supplied target PostgreSQL server
   * (via psql). Returns the job id; poll `getTransferJob(jobId)` for
   * progress until status is `success` or `failed`.
   */
  async startDatabaseTransfer(
    baseUrl: string,
    instanceId: string,
    payload: DatabaseTransferPayload,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<{ jobId: string; status: string }> {
    const url = `${baseUrl.replace(/\/+$/, '')}/instances/${encodeURIComponent(
      instanceId,
    )}/transfer-database`;
    const res = await fetchWithLifecycleRetry(fetchFn, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = `Transfer request failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        const err = body?.error;
        if (typeof err === 'string' && err.trim()) {
          msg = err;
        } else if (err && typeof err === 'object' && typeof err.message === 'string') {
          msg = err.message;
        }
      } catch {
        // ignore body parse failure
      }
      throw new Error(msg);
    }
    return (await res.json()) as { jobId: string; status: string };
  }

  /**
   * Snapshot a running or completed database transfer job.
   */
  async getTransferJob(
    baseUrl: string,
    jobId: string,
    fetchFn: typeof fetch = (...args) => fetch(...args),
  ): Promise<TransferJobSnapshot> {
    const url = `${baseUrl.replace(/\/+$/, '')}/databases/transfers/${encodeURIComponent(
      jobId,
    )}`;
    const res = await fetchWithLifecycleRetry(fetchFn, url);
    if (!res.ok) {
      throw new Error(`Failed to load transfer job (HTTP ${res.status})`);
    }
    return (await res.json()) as TransferJobSnapshot;
  }
}

/** Payload sent to POST /api/dhis2/instances/provision. */
export interface ProvisionInstancePayload {
  name: string;
  domain: string;
  version: string;
  node: string;
  vmid: number;
  hostname: string;
  email: string;
  resources: { cpu: number; memory: number; storage: number };
  database: { name: string; user: string; password: string };
  adminPassword?: string;
  rootPassword?: string;
  newDbAccount?: { user: string; password: string };
  skipCertbot?: boolean;
  /**
   * When true, the orchestrator will first stop + delete any existing
   * LXC container with the same VMID (and tear down the matching nginx
   * vhost on the Proxmox host) before provisioning the new one. The UI
   * gates this behind a confirmation prompt.
   */
  deleteIfExists?: boolean;
  /**
   * Major Apache Tomcat version (`'9'` or `'10'`) the orchestrator should
   * install inside the new LXC. Forwarded to `provision-instance.sh
   * --tomcat-version` and consumed by the Ansible `dhis2` role.
   */
  tomcatVersion?: '9' | '10';
  /**
   * Optional Proxmox API credentials from the ProxmoxClusterPanel saved
   * settings. When provided, individual fields override the server-side
   * `dhis2.orchestrator.*` / `PROXMOX_*` env-var config for this job. The
   * backend accepts `apiTokenId` either as the bare token name (e.g.
   * `backstage`) or the full token id (`root@pam!backstage`).
   */
  proxmox?: {
    apiUrl?: string;
    apiUser?: string;
    apiTokenId?: string;
    apiTokenSecret?: string;
    validateApiCerts?: boolean;
  };
}

export type ProvisionJobStatus = 'queued' | 'running' | 'success' | 'failed';

export interface ProvisionJobSnapshot {
  id: string;
  status: ProvisionJobStatus;
  exitCode?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  lines: string[];
  request: {
    name: string;
    domain: string;
    version: string;
    node: string;
    vmid: number;
  };
  instance?: DHIS2Instance;
}

export const dhis2Service = new DHIS2Service();

/** Payload sent to POST /api/dhis2/instances/:id/transfer-database. */
export interface DatabaseTransferPayload {
  source: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  target: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  options?: {
    createTargetDatabase?: boolean;
    dropTargetIfExists?: boolean;
    noOwner?: boolean;
    noPrivileges?: boolean;
    clean?: boolean;
    maintenanceDatabase?: string;
  };
}

export type TransferJobStatus = 'queued' | 'running' | 'success' | 'failed';

export interface TransferJobSnapshot {
  id: string;
  instanceId: string;
  status: TransferJobStatus;
  exitCode?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  lines: string[];
  request: {
    source: { host: string; port: number; user: string; database: string };
    target: { host: string; port: number; user: string; database: string };
    options: {
      createTargetDatabase: boolean;
      dropTargetIfExists: boolean;
      noOwner: boolean;
      noPrivileges: boolean;
      clean: boolean;
      maintenanceDatabase: string;
    };
  };
}
