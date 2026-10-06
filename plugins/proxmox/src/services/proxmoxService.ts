import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/core-plugin-api';
import {
  AttentionItem,
  ProxmoxCluster,
  ProxmoxDisk,
  ProxmoxDiskSmart,
  ProxmoxResources,
} from '@iswesolutions/plugin-proxmox-common';

/** Fields for adding/editing a cluster (token write-only). */
export interface ClusterInput {
  name: string;
  url: string;
  token?: string;
  verifyTls?: boolean;
  uiUrls?: Record<string, string>;
}

/**
 * Client for the Proxmox backend plugin (/api/proxmox), which holds the
 * read-only PVE API tokens and aggregates /cluster/resources per cluster.
 */
export interface ProxmoxApi {
  getClusters(): Promise<{ clusters: ProxmoxCluster[] }>;
  getResources(clusterId?: string): Promise<ProxmoxResources>;
  getAttention(
    clusterId?: string,
  ): Promise<{ items: AttentionItem[]; generatedAt: string }>;
  getDisks(clusterId?: string): Promise<{ disks: ProxmoxDisk[] }>;
  getDiskSmart(
    node: string,
    disk: string,
    clusterId?: string,
  ): Promise<ProxmoxDiskSmart>;
  addCluster(input: ClusterInput): Promise<ProxmoxCluster>;
  updateCluster(id: string, input: ClusterInput): Promise<ProxmoxCluster>;
  deleteCluster(id: string): Promise<void>;
  testCluster(
    input: ClusterInput | { id: string },
  ): Promise<{ ok: boolean; message: string; nodes?: number }>;
}

export const proxmoxApiRef = createApiRef<ProxmoxApi>({
  id: 'plugin.proxmox.service',
});

export class ProxmoxClientApi implements ProxmoxApi {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const baseUrl = await this.discoveryApi.getBaseUrl('proxmox');
    const res = await this.fetchApi.fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body
      }
      throw new Error(message);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private json(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  private q(clusterId?: string) {
    return clusterId ? `?cluster=${encodeURIComponent(clusterId)}` : '';
  }

  getClusters() {
    return this.request<{ clusters: ProxmoxCluster[] }>('/clusters');
  }

  getResources(clusterId?: string) {
    return this.request<ProxmoxResources>(`/resources${this.q(clusterId)}`);
  }

  getAttention(clusterId?: string) {
    return this.request<{ items: AttentionItem[]; generatedAt: string }>(
      `/attention${this.q(clusterId)}`,
    );
  }

  getDisks(clusterId?: string) {
    return this.request<{ disks: ProxmoxDisk[] }>(`/disks${this.q(clusterId)}`);
  }

  getDiskSmart(node: string, disk: string, clusterId?: string) {
    const params = new URLSearchParams({ node, disk });
    if (clusterId) params.set('cluster', clusterId);
    return this.request<ProxmoxDiskSmart>(`/disks/smart?${params.toString()}`);
  }

  addCluster(input: ClusterInput) {
    return this.request<ProxmoxCluster>('/clusters', this.json(input));
  }

  updateCluster(id: string, input: ClusterInput) {
    return this.request<ProxmoxCluster>(`/clusters/${id}`, {
      ...this.json(input),
      method: 'PUT',
    });
  }

  async deleteCluster(id: string) {
    await this.request<void>(`/clusters/${id}`, { method: 'DELETE' });
  }

  testCluster(input: ClusterInput | { id: string }) {
    return this.request<{ ok: boolean; message: string; nodes?: number }>(
      '/clusters/test',
      this.json(input),
    );
  }
}
