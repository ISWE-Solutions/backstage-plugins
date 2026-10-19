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

export interface SystemMetrics {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  networkIn: number;
  networkOut: number;
  requestsPerSecond: number;
  errorRate: number;
  uptime: number;
}

export interface ServiceHealth {
  serviceName: string;
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  lastCheck: string;
  responseTime: number;
  errorCount: number;
  metrics: SystemMetrics;
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
