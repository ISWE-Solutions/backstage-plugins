export interface MetricData {
  timestamp: number;
  value: number;
}

export interface PrometheusMetric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  currentValue: number;
  unit?: string;
  labels?: Record<string, string>;
  history?: MetricData[];
}

/** Live health of one catalog Component (see services/liveHealth.ts). */
export interface ServiceHealth {
  serviceName: string;
  /** e.g. component:default/keycloak */
  entityRef: string;
  system?: string;
  /** URL from the iswesolutions.com/health-url annotation */
  url: string;
  /** Proxmox guests from the iswesolutions.com/proxmox-guests annotation */
  guests: string[];
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  /** Why the status isn't "healthy" */
  reasons: string[];
  /** % of 5-minute site checks over the last 24 h that got a 2xx/3xx */
  uptime24h?: number;
  responseTimeMs?: number;
  certDaysLeft?: number;
  /** Busiest guest's CPU, % of its allotted cores */
  cpuPercent?: number;
  /** Busiest guest's memory, % of its limit */
  memoryPercent?: number;
  lastCheck: string;
}

export interface GrafanaDashboard {
  id: string;
  uid: string;
  title: string;
  url: string;
  tags: string[];
  starred: boolean;
  folderTitle?: string;
}

export interface SecurityAlert {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  cve?: string;
  packageName: string;
  currentVersion: string;
  fixedVersion?: string;
  createdAt: string;
  repository: string;
  status: 'open' | 'dismissed' | 'fixed';
}

export interface CostData {
  service: string;
  dailyCost: number;
  monthlyCost: number;
  trend: 'up' | 'down' | 'stable';
  currency: string;
  resourceType: string;
}

export interface CostSummary {
  totalDailyCost: number;
  totalMonthlyCost: number;
  totalYearlyCost: number;
  currency: string;
  breakdown: CostData[];
  topCostServices: CostData[];
  costByCategory: Record<string, number>;
}
