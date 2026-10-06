import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/core-plugin-api';
import {
  IPAddress,
  Subnet,
  VLAN,
  IPStatus,
  IPCollection,
  SubnetCollection,
  VLANCollection,
  IPFilter,
  IPAMStatistics,
} from '../types';
import {
  PhpIpamResponse,
  Raw,
  STATUS_TO_TAG,
  toAddress,
  toIso,
} from '@iswesolutions/plugin-ipam-common';

/**
 * Client for phpIPAM, reached through the ipam
 * backend plugin at /api/ipam/phpipam, which holds the `backstage` API app
 * code and checks the ipam.*.create permissions on writes.
 * Addresses are populated by phpIPAM's own ping/discovery scans and by the
 * ipam_sync.py job (Proxmox guests, DHCP leases, ARP) — see the IPAM docs.
 */
export interface IpamConfig {
  dhcpRanges: { from: string; to: string }[];
  proxmoxUiUrls: Record<string, string>;
  allocationPool: {
    from: string;
    to: string;
    gateway: string;
    prefix: number;
  } | null;
}

export interface UsagePoint {
  date: string;
  subnetId: string;
  cidr: string;
  used: number;
  max: number;
}

export interface SyncRun {
  finishedAt: string;
  durationSeconds: number;
  sources: Record<string, number>;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
}

export interface AddressChange {
  date: string;
  user: string;
  action: string;
  result: string;
  diff: string;
}

export const ipamApiRef = createApiRef<IPAMService>({
  id: 'plugin.ipam.service',
});

export class IPAMService {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
    /** phpIPAM section that new subnets are added to (default: the first) */
    private readonly subnetSection?: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: object,
  ): Promise<T | undefined> {
    const base = `${await this.discoveryApi.getBaseUrl('ipam')}/phpipam`;
    const response = await this.fetchApi.fetch(
      `${base}/${path.replace(/^\/|\/$/g, '')}/`,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    // phpIPAM answers 404 for an empty collection
    if (response.status === 404 && method === 'GET') return undefined;
    // an empty body (e.g. on DELETE) counts as success when the status is OK
    const payload = (await response
      .json()
      .catch(() => ({ success: response.ok }))) as PhpIpamResponse<T>;
    if (!response.ok || !payload.success) {
      throw new Error(
        `phpIPAM ${method} ${path} failed: ${
          payload.message ?? response.statusText
        }`,
      );
    }
    return payload.data;
  }

  private async rawSubnets(): Promise<Raw[]> {
    const all = (await this.request<Raw[]>('GET', 'subnets')) ?? [];
    return all.filter(
      s =>
        String(s.isFolder) !== '1' &&
        s.subnet &&
        !String(s.subnet).includes(':'),
    );
  }

  private async toSubnet(raw: Raw): Promise<Subnet> {
    const usage =
      (await this.request<Raw>('GET', `subnets/${raw.id}/usage`).catch(
        () => undefined,
      )) ?? {};
    const total = Number(usage.maxhosts ?? 0);
    const used = Number(usage.used ?? 0);
    return {
      id: String(raw.id),
      network: raw.subnet,
      cidr: Number(raw.mask),
      gateway: raw.gateway?.ip_addr,
      description: raw.description ?? undefined,
      vlanId: raw.vlanId && raw.vlanId !== '0' ? String(raw.vlanId) : undefined,
      location: raw.location ?? undefined,
      totalIPs: total,
      usedIPs: used,
      availableIPs: Math.max(total - used, 0),
      utilizationPercent: total ? (used / total) * 100 : 0,
      createdAt: toIso(raw.editDate) ?? new Date(0).toISOString(),
      updatedAt: toIso(raw.editDate) ?? new Date(0).toISOString(),
    };
  }

  async getSubnets(): Promise<SubnetCollection> {
    const subnets = await Promise.all(
      (await this.rawSubnets()).map(s => this.toSubnet(s)),
    );
    return { subnets, total_entries: subnets.length };
  }

  async getVLANs(): Promise<VLANCollection> {
    const [raw, subnets] = await Promise.all([
      this.request<Raw[]>('GET', 'vlan'),
      this.rawSubnets(),
    ]);
    const vlans: VLAN[] = (raw ?? []).map(v => ({
      id: String(v.vlanId),
      vlanId: Number(v.number),
      name: v.name,
      description: v.description ?? undefined,
      subnets: subnets
        .filter(s => String(s.vlanId) === String(v.vlanId))
        .map(s => String(s.id)),
      createdAt: toIso(v.editDate) ?? new Date(0).toISOString(),
      updatedAt: toIso(v.editDate) ?? new Date(0).toISOString(),
    }));
    return { vlans, total_entries: vlans.length };
  }

  async getIPAddresses(filter?: IPFilter): Promise<IPCollection> {
    const [raw, subnets] = await Promise.all([
      this.request<Raw[]>(
        'GET',
        filter?.subnetId ? `subnets/${filter.subnetId}/addresses` : 'addresses',
      ),
      this.rawSubnets(),
    ]);
    const vlanBySubnet = new Map(
      subnets.map(s => [
        String(s.id),
        s.vlanId && s.vlanId !== '0' ? String(s.vlanId) : undefined,
      ]),
    );
    let addresses = (raw ?? []).map(a => toAddress(a, vlanBySubnet));

    if (filter?.status)
      addresses = addresses.filter(ip => ip.status === filter.status);
    if (filter?.vlanId)
      addresses = addresses.filter(ip => ip.vlanId === filter.vlanId);
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      addresses = addresses.filter(ip =>
        [
          ip.ipAddress,
          ip.hostname,
          ip.description,
          ip.assignedTo,
          ip.macAddress,
          ip.source,
        ].some(v => v?.toLowerCase().includes(q)),
      );
    }
    return { addresses, total_entries: addresses.length };
  }

  async getStatistics(): Promise<IPAMStatistics> {
    const [{ subnets }, { addresses }, { vlans }] = await Promise.all([
      this.getSubnets(),
      this.getIPAddresses(),
      this.getVLANs(),
    ]);
    const totalIPs = subnets.reduce((sum, s) => sum + s.totalIPs, 0);
    const count = (status: IPStatus) =>
      addresses.filter(ip => ip.status === status).length;
    const allocatedIPs =
      count(IPStatus.ALLOCATED) +
      count(IPStatus.DHCP) +
      count(IPStatus.OFFLINE);
    const reservedIPs = count(IPStatus.RESERVED);

    const subnetsByVLAN: Record<string, number> = {};
    vlans.forEach(v => {
      subnetsByVLAN[v.name] = v.subnets.length;
    });

    return {
      totalSubnets: subnets.length,
      totalIPs,
      allocatedIPs,
      availableIPs: Math.max(totalIPs - allocatedIPs - reservedIPs, 0),
      reservedIPs,
      utilizationPercent: totalIPs ? (allocatedIPs / totalIPs) * 100 : 0,
      subnetsByVLAN,
      topUtilizedSubnets: [...subnets]
        .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
        .slice(0, 5),
    };
  }

  async addIPAddress(
    ip: Omit<IPAddress, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    await this.request('POST', 'addresses', {
      subnetId: ip.subnetId,
      ip: ip.ipAddress,
      hostname: ip.hostname,
      description: ip.description,
      owner: ip.assignedTo,
      mac: ip.macAddress,
      tag: STATUS_TO_TAG[ip.status],
      // phpIPAM addresses have no device-type or location field
      note:
        [
          ip.notes,
          ip.deviceType && `Device type: ${ip.deviceType}`,
          ip.location && `Location: ${ip.location}`,
        ]
          .filter(Boolean)
          .join('\n') || undefined,
    });
  }

  private async backendGet<T>(path: string): Promise<T> {
    const base = await this.discoveryApi.getBaseUrl('ipam');
    const response = await this.fetchApi.fetch(`${base}${path}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        body?.error?.message ?? `${path} failed (${response.status})`,
      );
    }
    return body as T;
  }

  /** Daily subnet usage snapshots for the last N days */
  getUsageHistory(days = 90): Promise<UsagePoint[]> {
    return this.backendGet(`/usage-history?days=${days}`);
  }

  /** Most recent discovery sync runs, newest first */
  getSyncStatus(limit = 20): Promise<SyncRun[]> {
    return this.backendGet(`/sync-status?limit=${limit}`);
  }

  /** Hostname / DNS disagreements (cached for 10 minutes by the backend) */
  getDnsCheck(): Promise<{
    checkedAt: string;
    mismatches: { ip: string; hostname: string; problem: string }[];
  }> {
    return this.backendGet('/dns-check');
  }

  /** Non-secret backend settings: DHCP pools, Proxmox UI links, allocation pool */
  async getConfig(): Promise<IpamConfig> {
    const base = await this.discoveryApi.getBaseUrl('ipam');
    const response = await this.fetchApi.fetch(`${base}/config`);
    if (!response.ok)
      return { dhcpRanges: [], proxmoxUiUrls: {}, allocationPool: null };
    return response.json();
  }

  async updateAddress(
    id: string,
    changes: Partial<
      Pick<
        IPAddress,
        | 'hostname'
        | 'description'
        | 'assignedTo'
        | 'macAddress'
        | 'status'
        | 'notes'
      >
    >,
  ): Promise<void> {
    await this.request('PATCH', `addresses/${id}`, {
      hostname: changes.hostname,
      description: changes.description,
      owner: changes.assignedTo,
      mac: changes.macAddress,
      tag: changes.status ? STATUS_TO_TAG[changes.status] : undefined,
      note: changes.notes,
    });
  }

  async deleteAddress(id: string): Promise<void> {
    await this.request('DELETE', `addresses/${id}`);
  }

  /** phpIPAM changelog for one address, newest first */
  async getChangelog(id: string): Promise<AddressChange[]> {
    const raw =
      (await this.request<Raw[]>('GET', `addresses/${id}/changelog`)) ?? [];
    return raw
      .map(c => ({
        date: toIso(c.cdate) ?? '',
        user: c.real_name ?? c.username ?? 'unknown',
        action: c.caction ?? c.action ?? '',
        result: c.cresult ?? '',
        diff: c.cdiff ?? '',
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async splitSubnet(id: string, number: number): Promise<void> {
    await this.request('PATCH', `subnets/${id}/split`, { number });
  }

  /** First free child subnet of the given size inside a subnet, if any */
  async findFreeSubnet(id: string, mask: number): Promise<string | undefined> {
    return (
      (await this.request<string>(
        'GET',
        `subnets/${id}/first_subnet/${mask}`,
      )) ?? undefined
    );
  }

  async createVlan(vlan: {
    number: number;
    name: string;
    description?: string;
  }): Promise<void> {
    await this.request('POST', 'vlan', vlan);
  }

  async setSubnetVlan(
    subnetId: string,
    vlanId: string | undefined,
  ): Promise<void> {
    await this.request('PATCH', `subnets/${subnetId}/vlan`, {
      vlanId: vlanId ?? '0',
    });
  }

  /** Reserve the next free address in the allocation pool (ipam backend) */
  async allocate(request: { hostname: string; purpose: string }): Promise<{
    id: string;
    ip: string;
    prefix: number;
    gateway: string;
    nameserver?: string;
  }> {
    const base = await this.discoveryApi.getBaseUrl('ipam');
    const response = await this.fetchApi.fetch(`${base}/allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        body?.error?.message ?? `Allocation failed (${response.status})`,
      );
    }
    return body;
  }

  async getAllocationPool(): Promise<
    { from: string; to: string; gateway: string; prefix: number } | undefined
  > {
    const base = await this.discoveryApi.getBaseUrl('ipam');
    const response = await this.fetchApi.fetch(`${base}/allocations/pool`);
    return response.ok ? response.json() : undefined;
  }

  async addSubnet(
    subnet: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const sections = (await this.request<Raw[]>('GET', 'sections')) ?? [];
    const section =
      sections.find(s => s.name === this.subnetSection) ?? sections[0];
    if (!section)
      throw new Error('phpIPAM has no section to add the subnet to');
    await this.request('POST', 'subnets', {
      subnet: subnet.network,
      mask: subnet.cidr,
      sectionId: section.id,
      description: subnet.description,
      vlanId: subnet.vlanId,
      pingSubnet: 1,
      discoverSubnet: 1,
      scanAgent: 1,
    });
  }
}
