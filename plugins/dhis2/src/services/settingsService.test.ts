import { MockConfigApi } from '@backstage/test-utils';
import { DEFAULT_SETTINGS } from '../types';
import { SettingsService } from './settingsService';

const config = () =>
  new MockConfigApi({
    dhis2: {
      settingsDefaults: {
        proxmox: { apiUrl: 'https://10.0.0.10:8006', defaultNode: 'node1' },
        proxy: { host: '10.0.0.20' },
        replaceStoredValues: { proxy: { host: ['10.0.0.99'] } },
      },
    },
  });

const store = (settings: object) =>
  window.localStorage.setItem(
    'dhis2-plugin-settings',
    JSON.stringify(settings),
  );

describe('SettingsService', () => {
  afterEach(() => window.localStorage.clear());

  it('uses the shipped defaults when nothing is configured', () => {
    expect(new SettingsService().load()).toBe(DEFAULT_SETTINGS);
  });

  it('layers app-config defaults over the shipped ones', () => {
    const service = new SettingsService();
    service.configure(config());
    const { proxmox, proxy } = service.load();
    expect(proxmox.apiUrl).toBe('https://10.0.0.10:8006');
    expect(proxmox.defaultNode).toBe('node1');
    expect(proxmox.networkBridge).toBe(DEFAULT_SETTINGS.proxmox.networkBridge);
    expect(proxy.host).toBe('10.0.0.20');
  });

  it('replaces stored placeholders and listed stale values', () => {
    const service = new SettingsService();
    service.configure(config());
    store({
      proxmox: { apiUrl: DEFAULT_SETTINGS.proxmox.apiUrl },
      proxy: { host: '10.0.0.99' },
    });
    const { proxmox, proxy } = service.load();
    expect(proxmox.apiUrl).toBe('https://10.0.0.10:8006');
    expect(proxy.host).toBe('10.0.0.20');
  });

  it('keeps values the user saved', () => {
    const service = new SettingsService();
    service.configure(config());
    store({ proxy: { host: 'nginx.internal' } });
    expect(service.load().proxy.host).toBe('nginx.internal');
  });
});
