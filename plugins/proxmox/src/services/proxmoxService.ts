import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/core-plugin-api';
import {
  AttentionItem,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';

/**
 * Client for the Proxmox backend plugin (/api/proxmox), which holds the
 * read-only PVE API token and aggregates /cluster/resources. Read-only.
 */
export interface ProxmoxApi {
  getResources(): Promise<ProxmoxResources>;
  getAttention(): Promise<{ items: AttentionItem[]; generatedAt: string }>;
}

export const proxmoxApiRef = createApiRef<ProxmoxApi>({
  id: 'plugin.proxmox.service',
});

export class ProxmoxClientApi implements ProxmoxApi {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
  ) {}

  private async request<T>(path: string): Promise<T> {
    const base = await this.discoveryApi.getBaseUrl('proxmox');
    const res = await this.fetchApi.fetch(`${base}${path}`);
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
    return res.json() as Promise<T>;
  }

  getResources(): Promise<ProxmoxResources> {
    return this.request<ProxmoxResources>('/resources');
  }

  getAttention(): Promise<{ items: AttentionItem[]; generatedAt: string }> {
    return this.request('/attention');
  }
}
