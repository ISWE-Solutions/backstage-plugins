import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';

export interface IpAllocation {
  /** phpIPAM address id, used to confirm or release */
  id: string;
  ip: string;
  prefix: number;
  gateway: string;
}

/**
 * Static-address allocation for new containers, provided by the ipam backend
 * plugin (see plugins/ipam-backend/src/allocation.ts).
 */
export interface IpAllocator {
  allocate(request: {
    hostname: string;
    purpose: string;
    requestedBy?: string;
  }): Promise<IpAllocation>;
  confirm(
    id: string,
    details: { hostname?: string; description?: string },
  ): Promise<void>;
  release(id: string): Promise<void>;
}

/** Calls the ipam backend as the dhis2 plugin (service-to-service auth) */
export function createIpamAllocator(deps: {
  discovery: DiscoveryService;
  auth: AuthService;
}): IpAllocator {
  const call = async (method: string, path: string, body?: unknown) => {
    const base = await deps.discovery.getBaseUrl('ipam');
    const { token } = await deps.auth.getPluginRequestToken({
      onBehalfOf: await deps.auth.getOwnServiceCredentials(),
      targetPluginId: 'ipam',
    });
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text)?.error?.message ?? text;
      } catch {
        // not JSON
      }
      throw new Error(
        `IPAM ${method} ${path} failed (${res.status}): ${message}`,
      );
    }
    return res.status === 204 ? undefined : res.json();
  };

  return {
    allocate: request =>
      call('POST', '/allocations', request) as Promise<IpAllocation>,
    confirm: async (id, details) => {
      await call(
        'POST',
        `/allocations/${encodeURIComponent(id)}/confirm`,
        details,
      );
    },
    release: async id => {
      await call('DELETE', `/allocations/${encodeURIComponent(id)}`);
    },
  };
}
