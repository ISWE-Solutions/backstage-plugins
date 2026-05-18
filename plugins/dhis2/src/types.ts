// API types and interfaces for Proxmox VE

export interface ProxmoxNode {
  node: string;
  status: 'online' | 'offline';
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
}

export interface LXCContainer {
  vmid: string;
  name: string;
  status: 'running' | 'stopped';
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  node: string;
  template?: number;
}

export interface LXCConfig {
  hostname: string;
  memory: number;
  cores: number;
  rootfs: string;
  ostemplate: string;
  network: string;
  nameserver: string;
  searchdomain: string;
  password?: string;
  unprivileged?: number;
  features?: string;
}

export interface ProxmoxTask {
  upid: string;
  type: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
}

// DHIS2 Instance types

export interface DHIS2Instance {
  id: string;
  name: string;
  vmid: string;
  node: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error';
  version: string;
  url: string;
  domain: string;
  database: {
    name: string;
    user: string;
  };
  resources: {
    cpu: number;
    memory: number;
    storage: number;
  };
  created: string;
  updated: string;
}

export interface CreateInstanceRequest {
  name: string;
  domain: string;
  version: string;
  node: string;
  resources: {
    cpu: number;
    memory: number; // in MB
    storage: number; // in GB
  };
  database: {
    name: string;
    user: string;
    password: string;
  };
  adminPassword: string;
}

// Nginx configuration types

export interface NginxUpstream {
  name: string;
  servers: string[];
}

export interface NginxServer {
  domain: string;
  upstreamName: string;
  sslCert?: string;
  sslKey?: string;
}

export interface NginxConfig {
  upstreams: NginxUpstream[];
  servers: NginxServer[];
}
