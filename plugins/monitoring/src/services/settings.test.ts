import { ConfigReader } from '@backstage/config';
import { effectiveConfig, loadSettings, nest } from './settings';
import { readCostConfig } from './costModel';
import { readElectricityConfig } from './electricity';

// like the app's config: several files, merged
const appConfig = ConfigReader.fromConfigs([
  {
    context: 'app-config.yaml',
    data: {
      app: { title: 'X' },
      monitoring: { costs: { currency: 'USD', split: { cpu: 0.5 } } },
    },
  },
  {
    context: 'app-config.production.yaml',
    data: {
      monitoring: { costs: { currency: 'ZMW' }, grafanaFolderOrder: ['VSDC'] },
    },
  },
]);
const saved = (value: number | string) => ({
  value,
  updatedBy: 'user:default/a',
  updatedAt: '2026-11-14T00:00:00Z',
});

describe('settings', () => {
  it('nests flat keys under monitoring', () => {
    expect(nest({ 'costs.split.cpu': 0.4, 'costs.currency': 'ZMW' })).toEqual({
      monitoring: { costs: { split: { cpu: 0.4 }, currency: 'ZMW' } },
    });
  });

  it('puts saved settings on top of app-config and keeps the rest', () => {
    const c = effectiveConfig(appConfig, {
      'costs.electricity.tariffPerKwh': saved(2.94),
      'costs.split.memory': saved(0.3),
    });
    expect(readElectricityConfig(c).tariffPerKwh).toBe(2.94);
    const costs = readCostConfig(c);
    expect(costs.currency).toBe('ZMW'); // from app-config.production.yaml
    expect(costs.split.cpu).toBe(0.5); // from app-config.yaml
    expect(costs.split.memory).toBe(0.3); // saved
    expect(c.getOptionalStringArray('monitoring.grafanaFolderOrder')).toEqual([
      'VSDC',
    ]);
    expect(c.getString('app.title')).toBe('X');
    const over = effectiveConfig(appConfig, { 'costs.currency': saved('USD') });
    expect(readCostConfig(over).currency).toBe('USD');
  });

  it('is app-config alone with nothing saved', () => {
    expect(effectiveConfig(appConfig, {})).toBe(appConfig);
  });

  it('says when the backend is missing', async () => {
    const s = await loadSettings({
      discoveryApi: { getBaseUrl: async () => 'http://b/api/monitoring' },
      fetchApi: { fetch: async () => ({ ok: false, status: 404 }) } as any,
    });
    expect(s).toMatchObject({
      available: false,
      canEdit: false,
      error: 'HTTP 404',
    });
  });
});
