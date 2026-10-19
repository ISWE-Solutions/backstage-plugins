import {
  PrometheusMetric,
  GrafanaDashboard,
  SecurityAlert,
  CostSummary,
  MetricData,
} from '../types';

// Mock data for Prometheus metrics
const generateMetricHistory = (
  baseValue: number,
  points: number = 24,
): MetricData[] => {
  const now = Date.now();
  return Array.from({ length: points }, (_, i) => ({
    timestamp: now - (points - i) * 3600000, // Hourly data
    value: baseValue + Math.random() * baseValue * 0.2 - baseValue * 0.1,
  }));
};

const mockPrometheusMetrics: PrometheusMetric[] = [
  {
    name: 'http_requests_total',
    type: 'counter',
    help: 'Total HTTP requests',
    currentValue: 1523847,
    unit: 'requests',
    labels: { service: 'openemr', method: 'GET' },
    history: generateMetricHistory(1500000, 24),
  },
  {
    name: 'system_cpu_usage',
    type: 'gauge',
    help: 'System CPU usage percentage',
    currentValue: 42.5,
    unit: '%',
    labels: { host: 'server-01' },
    history: generateMetricHistory(45, 24),
  },
  {
    name: 'system_memory_usage',
    type: 'gauge',
    help: 'System memory usage percentage',
    currentValue: 68.3,
    unit: '%',
    labels: { host: 'server-01' },
    history: generateMetricHistory(65, 24),
  },
  {
    name: 'http_request_duration_seconds',
    type: 'histogram',
    help: 'HTTP request duration',
    currentValue: 0.234,
    unit: 'seconds',
    labels: { service: 'dhis2' },
    history: generateMetricHistory(0.25, 24),
  },
  {
    name: 'database_connections_active',
    type: 'gauge',
    help: 'Active database connections',
    currentValue: 45,
    unit: 'connections',
    labels: { database: 'openmrs_prod' },
    history: generateMetricHistory(50, 24),
  },
];

const mockGrafanaDashboards: GrafanaDashboard[] = [
  {
    id: '1',
    uid: 'openemr-overview',
    title: 'OpenMRS System Overview',
    url: 'https://grafana.example.org/d/openemr-overview',
    tags: ['ehr', 'production', 'health'],
    starred: true,
    folderTitle: 'Healthcare Systems',
  },
  {
    id: '2',
    uid: 'dhis2-analytics',
    title: 'DHIS2 Analytics Dashboard',
    url: 'https://grafana.example.org/d/dhis2-analytics',
    tags: ['hmis', 'analytics', 'reporting'],
    starred: true,
    folderTitle: 'Healthcare Systems',
  },
  {
    id: '3',
    uid: 'infrastructure-monitoring',
    title: 'Infrastructure Monitoring',
    url: 'https://grafana.example.org/d/infrastructure-monitoring',
    tags: ['infrastructure', 'servers', 'network'],
    starred: false,
    folderTitle: 'Infrastructure',
  },
  {
    id: '4',
    uid: 'database-performance',
    title: 'Database Performance',
    url: 'https://grafana.example.org/d/database-performance',
    tags: ['database', 'postgresql', 'performance'],
    starred: true,
    folderTitle: 'Infrastructure',
  },
];

const mockSecurityAlerts: SecurityAlert[] = [
  {
    id: 'sec-001',
    severity: 'critical',
    title: 'Critical SQL Injection Vulnerability in OpenMRS',
    description:
      'SQL injection vulnerability allowing unauthorized database access',
    cve: 'CVE-2024-12345',
    packageName: 'openmrs-core',
    currentVersion: '2.5.0',
    fixedVersion: '2.5.7',
    createdAt: '2026-02-01T10:30:00Z',
    repository: 'openmrs/openmrs-core',
    status: 'open',
  },
  {
    id: 'sec-002',
    severity: 'high',
    title: 'Cross-Site Scripting (XSS) in DHIS2',
    description: 'XSS vulnerability in dashboard component',
    cve: 'CVE-2024-54321',
    packageName: 'dhis2-core',
    currentVersion: '2.39.1',
    fixedVersion: '2.39.3',
    createdAt: '2026-01-28T14:20:00Z',
    repository: 'dhis2/dhis2-core',
    status: 'open',
  },
  {
    id: 'sec-003',
    severity: 'medium',
    title: 'Outdated SSL Certificate on Pharmacy System',
    description: 'SSL certificate expires in 30 days',
    packageName: 'pharmacy-management',
    currentVersion: '1.2.3',
    createdAt: '2026-02-02T09:15:00Z',
    repository: 'example-org/pharmacy-system',
    status: 'open',
  },
  {
    id: 'sec-004',
    severity: 'low',
    title: 'Deprecated API Usage in Laboratory System',
    description: 'Using deprecated FHIR API version',
    packageName: 'lims',
    currentVersion: '3.1.0',
    fixedVersion: '3.2.0',
    createdAt: '2026-01-25T11:45:00Z',
    repository: 'example-org/lims',
    status: 'dismissed',
  },
];

const mockCostSummary: CostSummary = {
  totalDailyCost: 247.5,
  totalMonthlyCost: 7425.0,
  totalYearlyCost: 89100.0,
  currency: 'USD',
  breakdown: [
    {
      service: 'OpenMRS Production Servers',
      dailyCost: 85.0,
      monthlyCost: 2550.0,
      trend: 'stable',
      currency: 'USD',
      resourceType: 'compute',
    },
    {
      service: 'DHIS2 Infrastructure',
      dailyCost: 72.5,
      monthlyCost: 2175.0,
      trend: 'up',
      currency: 'USD',
      resourceType: 'compute',
    },
    {
      service: 'Database Hosting',
      dailyCost: 45.0,
      monthlyCost: 1350.0,
      trend: 'stable',
      currency: 'USD',
      resourceType: 'database',
    },
    {
      service: 'Network & CDN',
      dailyCost: 25.0,
      monthlyCost: 750.0,
      trend: 'down',
      currency: 'USD',
      resourceType: 'network',
    },
    {
      service: 'Backup Storage',
      dailyCost: 20.0,
      monthlyCost: 600.0,
      trend: 'up',
      currency: 'USD',
      resourceType: 'storage',
    },
  ],
  topCostServices: [
    {
      service: 'OpenMRS Production Servers',
      dailyCost: 85.0,
      monthlyCost: 2550.0,
      trend: 'stable',
      currency: 'USD',
      resourceType: 'compute',
    },
    {
      service: 'DHIS2 Infrastructure',
      dailyCost: 72.5,
      monthlyCost: 2175.0,
      trend: 'up',
      currency: 'USD',
      resourceType: 'compute',
    },
    {
      service: 'Database Hosting',
      dailyCost: 45.0,
      monthlyCost: 1350.0,
      trend: 'stable',
      currency: 'USD',
      resourceType: 'database',
    },
  ],
  costByCategory: {
    compute: 4725.0,
    database: 1350.0,
    network: 750.0,
    storage: 600.0,
  },
};

export class MonitoringService {
  async getPrometheusMetrics(): Promise<PrometheusMetric[]> {
    // In production, this would call actual Prometheus API
    return Promise.resolve(mockPrometheusMetrics);
  }

  async getGrafanaDashboards(): Promise<GrafanaDashboard[]> {
    // In production, this would call Grafana API
    return Promise.resolve(mockGrafanaDashboards);
  }

  async getSecurityAlerts(): Promise<SecurityAlert[]> {
    // In production, this would call GitHub Security API or similar
    return Promise.resolve(mockSecurityAlerts);
  }

  async getCostSummary(): Promise<CostSummary> {
    // In production, this would call cloud provider APIs
    return Promise.resolve(mockCostSummary);
  }
}

export const monitoringService = new MonitoringService();
