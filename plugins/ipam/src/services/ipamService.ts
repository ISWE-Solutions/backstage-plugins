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

/**
 * Client for phpIPAM (LXC 116, 10.20.30.127), reached through the ipam
 * backend plugin at /api/ipam/phpipam, which holds the `backstage` API app
 * code and checks the ipam.*.create permissions on writes.
 * Addresses are populated by phpIPAM's own ping/discovery scans and by the
 * ipam_sync.py job (Proxmox guests, DHCP leases, ARP) — see the IPAM docs.
 */
export const ipamApiRef = createApiRef<IPAMService>({
  id: 'plugin.ipam.service',
});

// phpIPAM address tags (ipTags table)
const TAG_TO_STATUS: Record<string, IPStatus> = {
  '1': IPStatus.OFFLINE,
  '2': IPStatus.ALLOCATED,
  '3': IPStatus.RESERVED,
  '4': IPStatus.DHCP,
};
const STATUS_TO_TAG: Record<IPStatus, number> = {
  [IPStatus.OFFLINE]: 1,
  [IPStatus.ALLOCATED]: 2,
  [IPStatus.RESERVED]: 3,
  [IPStatus.DHCP]: 4,
};

const DISCOVERY_MARKER = 'discovery:';
// note phpIPAM's own discoveryCheck.php puts on hosts found by its ping sweep
const SCAN_NOTE = 'This host was autodiscovered';

interface PhpIpamResponse<T> {
  code: number;
  success: boolean | number;
  data?: T;
  message?: string;
}

type Raw = Record<string, any>;

const toIso = (value?: string | null) =>
  value && !value.startsWith('0000')
    ? new Date(value.replace(' ', 'T')).toISOString()
    : undefined;

/** "discovery: proxmox+arp; LXC 115 on pve11; last seen ..." -> "proxmox+arp" */
const sourceFromNote = (note?: string | null) => {
  const lines = (note ?? '').split('\n');
  const line = lines.find(l => l.startsWith(DISCOVERY_MARKER));
  if (line) return line.slice(DISCOVERY_MARKER.length).split(';')[0].trim();
  return lines.some(l => l.startsWith(SCAN_NOTE)) ? 'scan' : 'manual';
};

export class IPAMService {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
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
    const payload = (await response
      .json()
      .catch(() => ({}))) as PhpIpamResponse<T>;
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

  private toAddress(
    raw: Raw,
    vlanBySubnet: Map<string, string | undefined>,
  ): IPAddress {
    return {
      id: String(raw.id),
      ipAddress: raw.ip,
      subnetId: String(raw.subnetId),
      hostname: raw.hostname ?? undefined,
      description: raw.description ?? undefined,
      status: TAG_TO_STATUS[String(raw.tag)] ?? IPStatus.ALLOCATED,
      assignedTo: raw.owner ?? undefined,
      macAddress: raw.mac ?? undefined,
      source: sourceFromNote(raw.note),
      vlanId: vlanBySubnet.get(String(raw.subnetId)),
      lastSeen: toIso(raw.lastSeen),
      notes: raw.note ?? undefined,
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
    let addresses = (raw ?? []).map(a => this.toAddress(a, vlanBySubnet));

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

  async addSubnet(
    subnet: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const sections = (await this.request<Raw[]>('GET', 'sections')) ?? [];
    const section = sections.find(s => s.name === 'DC1') ?? sections[0];
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
