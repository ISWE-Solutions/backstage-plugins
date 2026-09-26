export interface IPAddress {
  id: string;
  ipAddress: string;
  subnetId: string;
  hostname?: string;
  description?: string;
  status: IPStatus;
  assignedTo?: string;
  macAddress?: string;
  deviceType?: string;
  location?: string;
  /** How the address got into phpIPAM: "manual", or discovery sources such as "proxmox+arp" */
  source?: string;
  vlanId?: string;
  lastSeen?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subnet {
  id: string;
  network: string;
  cidr: number;
  gateway?: string;
  description?: string;
  vlanId?: string;
  location?: string;
  totalIPs: number;
  usedIPs: number;
  availableIPs: number;
  utilizationPercent: number;
  createdAt: string;
  updatedAt: string;
}

export interface VLAN {
  id: string;
  vlanId: number;
  name: string;
  description?: string;
  subnets: string[];
  createdAt: string;
  updatedAt: string;
}

/** phpIPAM address tags */
export enum IPStatus {
  ALLOCATED = 'allocated',
  RESERVED = 'reserved',
  OFFLINE = 'offline',
  DHCP = 'dhcp',
}

export interface IPCollection {
  addresses: IPAddress[];
  total_entries: number;
}

export interface SubnetCollection {
  subnets: Subnet[];
  total_entries: number;
}

export interface VLANCollection {
  vlans: VLAN[];
  total_entries: number;
}

export interface IPFilter {
  subnetId?: string;
  status?: IPStatus;
  search?: string;
  vlanId?: string;
}

export interface IPAMStatistics {
  totalSubnets: number;
  totalIPs: number;
  allocatedIPs: number;
  availableIPs: number;
  reservedIPs: number;
  utilizationPercent: number;
  subnetsByVLAN: Record<string, number>;
  topUtilizedSubnets: Subnet[];
}
