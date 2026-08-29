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

// Mock data for development
const mockVLANs: VLAN[] = [
  {
    id: 'vlan-1',
    vlanId: 10,
    name: 'Management',
    description: 'Network management and administration',
    subnets: ['subnet-1'],
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 'vlan-2',
    vlanId: 20,
    name: 'Servers',
    description: 'Production servers and databases',
    subnets: ['subnet-2'],
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 'vlan-3',
    vlanId: 30,
    name: 'Workstations',
    description: 'Employee workstations and endpoints',
    subnets: ['subnet-3'],
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 'vlan-4',
    vlanId: 40,
    name: 'Guest WiFi',
    description: 'Guest wireless network',
    subnets: ['subnet-4'],
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  },
];

const mockSubnets: Subnet[] = [
  {
    id: 'subnet-1',
    network: '10.0.1.0',
    cidr: 24,
    gateway: '10.0.1.1',
    description: 'Management Network',
    vlanId: 'vlan-1',
    location: 'Example Data Center',
    totalIPs: 254,
    usedIPs: 45,
    availableIPs: 209,
    utilizationPercent: 17.7,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-03-20T14:30:00Z',
  },
  {
    id: 'subnet-2',
    network: '10.0.2.0',
    cidr: 24,
    gateway: '10.0.2.1',
    description: 'Server Network',
    vlanId: 'vlan-2',
    location: 'Example Data Center',
    totalIPs: 254,
    usedIPs: 187,
    availableIPs: 67,
    utilizationPercent: 73.6,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-03-20T14:30:00Z',
  },
  {
    id: 'subnet-3',
    network: '10.0.10.0',
    cidr: 22,
    gateway: '10.0.10.1',
    description: 'Workstation Network',
    vlanId: 'vlan-3',
    location: 'Example HQ',
    totalIPs: 1022,
    usedIPs: 456,
    availableIPs: 566,
    utilizationPercent: 44.6,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-03-20T14:30:00Z',
  },
  {
    id: 'subnet-4',
    network: '172.16.100.0',
    cidr: 24,
    gateway: '172.16.100.1',
    description: 'Guest WiFi Network',
    vlanId: 'vlan-4',
    location: 'Example HQ',
    totalIPs: 254,
    usedIPs: 23,
    availableIPs: 231,
    utilizationPercent: 9.1,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-03-20T14:30:00Z',
  },
];

const mockIPAddresses: IPAddress[] = [
  {
    id: 'ip-1',
    ipAddress: '10.0.1.10',
    subnetId: 'subnet-1',
    hostname: 'fw-primary.example.net',
    description: 'Primary Firewall',
    status: IPStatus.ALLOCATED,
    assignedTo: 'Network Infrastructure',
    macAddress: '00:1A:2B:3C:4D:5E',
    deviceType: 'Firewall',
    location: 'Example Data Center - Rack A01',
    vlanId: 'vlan-1',
    lastSeen: '2024-03-20T14:25:00Z',
    notes: 'Critical infrastructure - do not modify without approval',
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-03-20T14:25:00Z',
  },
  {
    id: 'ip-2',
    ipAddress: '10.0.2.50',
    subnetId: 'subnet-2',
    hostname: 'db-openmrs-prod.example.net',
    description: 'OpenMRS Production Database',
    status: IPStatus.ALLOCATED,
    assignedTo: 'OpenMRS EHR System',
    macAddress: '00:50:56:AB:CD:EF',
    deviceType: 'Database Server',
    location: 'Example Data Center - Rack B03',
    vlanId: 'vlan-2',
    lastSeen: '2024-03-20T14:28:00Z',
    notes: 'Production database - ensure backup procedures are followed',
    createdAt: '2024-02-01T09:00:00Z',
    updatedAt: '2024-03-20T14:28:00Z',
  },
  {
    id: 'ip-3',
    ipAddress: '10.0.2.51',
    subnetId: 'subnet-2',
    hostname: 'app-dhis2-prod.example.net',
    description: 'DHIS2 Application Server',
    status: IPStatus.ALLOCATED,
    assignedTo: 'DHIS2 HMIS',
    macAddress: '00:50:56:12:34:56',
    deviceType: 'Application Server',
    location: 'Example Data Center - Rack B04',
    vlanId: 'vlan-2',
    lastSeen: '2024-03-20T14:29:00Z',
    notes: 'National HMIS platform',
    createdAt: '2024-02-01T09:30:00Z',
    updatedAt: '2024-03-20T14:29:00Z',
  },
  {
    id: 'ip-4',
    ipAddress: '10.0.1.5',
    subnetId: 'subnet-1',
    hostname: 'switch-core-01.example.net',
    description: 'Core Network Switch',
    status: IPStatus.ALLOCATED,
    assignedTo: 'Network Infrastructure',
    macAddress: '00:1B:2C:3D:4E:5F',
    deviceType: 'Network Switch',
    location: 'Example Data Center - Rack A02',
    vlanId: 'vlan-1',
    lastSeen: '2024-03-20T14:27:00Z',
    createdAt: '2024-01-20T11:00:00Z',
    updatedAt: '2024-03-20T14:27:00Z',
  },
  {
    id: 'ip-5',
    ipAddress: '10.0.10.100',
    subnetId: 'subnet-3',
    hostname: 'ws-admin-001.example.net',
    description: 'Admin Workstation',
    status: IPStatus.ALLOCATED,
    assignedTo: 'John Mwansa - IT Department',
    macAddress: 'A4:5E:60:B1:C2:D3',
    deviceType: 'Workstation',
    location: 'Example HQ - Floor 3, Room 305',
    vlanId: 'vlan-3',
    lastSeen: '2024-03-20T14:20:00Z',
    createdAt: '2024-02-15T08:00:00Z',
    updatedAt: '2024-03-20T14:20:00Z',
  },
  {
    id: 'ip-6',
    ipAddress: '10.0.2.100',
    subnetId: 'subnet-2',
    hostname: 'backup-server-01.example.net',
    description: 'Backup Server',
    status: IPStatus.RESERVED,
    assignedTo: 'Infrastructure Team',
    deviceType: 'Server',
    location: 'Example Data Center - Rack C01',
    vlanId: 'vlan-2',
    notes: 'Reserved for new backup system deployment',
    createdAt: '2024-03-10T10:00:00Z',
    updatedAt: '2024-03-10T10:00:00Z',
  },
  {
    id: 'ip-7',
    ipAddress: '172.16.100.50',
    subnetId: 'subnet-4',
    hostname: '',
    description: 'Guest Device',
    status: IPStatus.ALLOCATED,
    macAddress: 'B8:27:EB:A1:B2:C3',
    deviceType: 'Mobile Device',
    location: 'Example HQ - Guest Area',
    vlanId: 'vlan-4',
    lastSeen: '2024-03-20T13:45:00Z',
    createdAt: '2024-03-20T10:30:00Z',
    updatedAt: '2024-03-20T13:45:00Z',
  },
];

export class IPAMService {
  async getIPAddresses(filter?: IPFilter): Promise<IPCollection> {
    let filtered = [...mockIPAddresses];

    if (filter?.subnetId) {
      filtered = filtered.filter(ip => ip.subnetId === filter.subnetId);
    }

    if (filter?.status) {
      filtered = filtered.filter(ip => ip.status === filter.status);
    }

    if (filter?.vlanId) {
      filtered = filtered.filter(ip => ip.vlanId === filter.vlanId);
    }

    if (filter?.search) {
      const searchLower = filter.search.toLowerCase();
      filtered = filtered.filter(
        ip =>
          ip.ipAddress.includes(searchLower) ||
          ip.hostname?.toLowerCase().includes(searchLower) ||
          ip.description?.toLowerCase().includes(searchLower) ||
          ip.assignedTo?.toLowerCase().includes(searchLower),
      );
    }

    return {
      addresses: filtered,
      total_entries: filtered.length,
    };
  }

  async getSubnets(): Promise<SubnetCollection> {
    return {
      subnets: mockSubnets,
      total_entries: mockSubnets.length,
    };
  }

  async getVLANs(): Promise<VLANCollection> {
    return {
      vlans: mockVLANs,
      total_entries: mockVLANs.length,
    };
  }

  async getStatistics(): Promise<IPAMStatistics> {
    const totalSubnets = mockSubnets.length;
    const totalIPs = mockSubnets.reduce(
      (sum, subnet) => sum + subnet.totalIPs,
      0,
    );
    const allocatedIPs = mockIPAddresses.filter(
      ip => ip.status === IPStatus.ALLOCATED,
    ).length;
    const reservedIPs = mockIPAddresses.filter(
      ip => ip.status === IPStatus.RESERVED,
    ).length;
    const availableIPs = totalIPs - allocatedIPs - reservedIPs;
    const utilizationPercent = (allocatedIPs / totalIPs) * 100;

    const subnetsByVLAN: Record<string, number> = {};
    mockVLANs.forEach(vlan => {
      subnetsByVLAN[vlan.name] = vlan.subnets.length;
    });

    const topUtilizedSubnets = [...mockSubnets]
      .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
      .slice(0, 5);

    return {
      totalSubnets,
      totalIPs,
      allocatedIPs,
      availableIPs,
      reservedIPs,
      utilizationPercent,
      subnetsByVLAN,
      topUtilizedSubnets,
    };
  }

  async addIPAddress(
    ip: Omit<IPAddress, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPAddress> {
    const newIP: IPAddress = {
      ...ip,
      id: `ip-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockIPAddresses.push(newIP);

    const subnet = mockSubnets.find(s => s.id === newIP.subnetId);
    if (subnet) {
      subnet.usedIPs += 1;
      subnet.availableIPs = subnet.totalIPs - subnet.usedIPs;
      subnet.utilizationPercent = (subnet.usedIPs / subnet.totalIPs) * 100;
      subnet.updatedAt = new Date().toISOString();
    }

    return newIP;
  }

  async addSubnet(
    subnet: Omit<Subnet, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Subnet> {
    const newSubnet: Subnet = {
      ...subnet,
      id: `subnet-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockSubnets.push(newSubnet);
    return newSubnet;
  }

  async addVLAN(
    vlan: Omit<VLAN, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<VLAN> {
    const newVLAN: VLAN = {
      ...vlan,
      id: `vlan-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockVLANs.push(newVLAN);
    return newVLAN;
  }

  async getSubnetById(id: string): Promise<Subnet | undefined> {
    return mockSubnets.find(subnet => subnet.id === id);
  }

  async getVLANById(id: string): Promise<VLAN | undefined> {
    return mockVLANs.find(vlan => vlan.id === id);
  }
}

export const ipamService = new IPAMService();
