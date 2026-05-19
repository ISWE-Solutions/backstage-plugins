import { DHIS2PluginSettings, DEFAULT_SETTINGS } from '../types';

const STORAGE_KEY = 'dhis2-plugin-settings';

/**
 * Frontend persistence for the DHIS2 plugin settings.
 *
 * Settings are kept in localStorage for now; once a backend plugin is
 * available the same shape can be PUT/GET against `/api/dhis2/settings`.
 */
export class SettingsService {
  load(): DHIS2PluginSettings {
    try {
      const raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(STORAGE_KEY)
          : null;
      if (!raw) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(raw) as Partial<DHIS2PluginSettings>;
      // Deep-merge with defaults so new fields don't break stored settings.
      return {
        proxmox: { ...DEFAULT_SETTINGS.proxmox, ...(parsed.proxmox ?? {}) },
        proxy: { ...DEFAULT_SETTINGS.proxy, ...(parsed.proxy ?? {}) },
        dhis2: { ...DEFAULT_SETTINGS.dhis2, ...(parsed.dhis2 ?? {}) },
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load DHIS2 plugin settings, using defaults', e);
      return DEFAULT_SETTINGS;
    }
  }

  save(settings: DHIS2PluginSettings): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  reset(): DHIS2PluginSettings {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    return DEFAULT_SETTINGS;
  }

  /**
   * Compute the public URL for a DHIS2 instance given its short name,
   * based on the configured proxy mode.
   */
  buildInstanceUrl(
    instanceName: string,
    settings: DHIS2PluginSettings = this.load(),
  ): string {
    const { proxy } = settings;
    const scheme = proxy.forceHttps ? 'https' : 'http';
    if (proxy.mode === 'subdomain') {
      return `${scheme}://${instanceName}.${proxy.baseDomain}`;
    }
    const prefix = proxy.pathPrefix ? `/${proxy.pathPrefix}` : '';
    return `${scheme}://${proxy.baseDomain}${prefix}/${instanceName}`;
  }
}

export const settingsService = new SettingsService();
