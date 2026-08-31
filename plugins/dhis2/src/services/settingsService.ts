import { DHIS2PluginSettings, DEFAULT_SETTINGS } from '../types';

const STORAGE_KEY = 'dhis2-plugin-settings';

function normalizePrivateKeyPath(pathLike?: string): string | undefined {
  const p = (pathLike ?? '').trim();
  if (!p) return undefined;
  return p.endsWith('.pub') ? p.slice(0, -4) : p;
}

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
      const merged: DHIS2PluginSettings = {
        proxmox: { ...DEFAULT_SETTINGS.proxmox, ...(parsed.proxmox ?? {}) },
        proxy: { ...DEFAULT_SETTINGS.proxy, ...(parsed.proxy ?? {}) },
        dhis2: { ...DEFAULT_SETTINGS.dhis2, ...(parsed.dhis2 ?? {}) },
      };
      merged.proxy.sshKeyPath =
        normalizePrivateKeyPath(merged.proxy.sshKeyPath) ??
        merged.proxy.sshKeyPath;
      // Migrate stale placeholder values from older builds to the current
      // defaults so the UI reflects the new defaults without forcing users
      // to clear localStorage manually.
      const stalePlaceholders: Record<keyof typeof merged.proxy, string[]> = {
        baseDomain: ['dhis2.example.com'],
        host: ['proxy.example.com'],
        sshKeyPath: ['/var/lib/backstage/.ssh/id_ed25519'],
        // Old Debian/Ubuntu sites-available layout — superseded by the
        // single conf.d directory (which nginx auto-includes).
        nginxConfigPath: ['/etc/nginx/sites-available'],
      } as any;
      (
        Object.keys(stalePlaceholders) as Array<keyof typeof merged.proxy>
      ).forEach(key => {
        const current = merged.proxy[key] as unknown as string;
        if (stalePlaceholders[key].includes(current)) {
          (merged.proxy as any)[key] = DEFAULT_SETTINGS.proxy[key];
        }
      });
      // pve10.example.org resolves to a public IP that doesn't forward
      // port 8006 (or does so with 100+ second latency), so any stored
      // apiUrl still pointing at that hostname must be corrected to the
      // internal cluster address — otherwise every direct (non-proxied)
      // Proxmox call from this browser times out. Applies regardless of
      // useBackstageProxy, since users may flip that toggle off later.
      const staleApiUrls = ['https://pve10.example.org:8006'];
      if (staleApiUrls.includes(merged.proxmox.apiUrl)) {
        merged.proxmox.apiUrl = DEFAULT_SETTINGS.proxmox.apiUrl;
      }
      // Older builds defaulted proxmox.verifyTls to true, which then
      // forwards as validateApiCerts=true into every provision request
      // and causes CERTIFICATE_VERIFY_FAILED against PVE's stock
      // self-signed certificate. Migrate the stale `true` to the new
      // `false` default whenever the stored proxmox settings still
      // carry the previous-generation marker (apiUrl untouched from
      // the placeholder, or tokenSecret blank — i.e. the operator has
      // never finished filling the panel in).
      if (
        parsed.proxmox &&
        parsed.proxmox.verifyTls === true &&
        // Only auto-flip when the operator hasn't explicitly opted in
        // by providing a non-default API URL AND a token secret. Once
        // they've configured a real PVE node we trust their toggle.
        (!parsed.proxmox.tokenSecret ||
          parsed.proxmox.apiUrl === DEFAULT_SETTINGS.proxmox.apiUrl)
      ) {
        merged.proxmox.verifyTls = DEFAULT_SETTINGS.proxmox.verifyTls;
      }
      return merged;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load DHIS2 plugin settings, using defaults', e);
      return DEFAULT_SETTINGS;
    }
  }

  save(settings: DHIS2PluginSettings): void {
    if (typeof window === 'undefined') return;
    const normalized: DHIS2PluginSettings = {
      ...settings,
      proxy: {
        ...settings.proxy,
        sshKeyPath:
          normalizePrivateKeyPath(settings.proxy.sshKeyPath) ??
          settings.proxy.sshKeyPath,
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
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
    if (proxy.pathPrefix) {
      return `${scheme}://${proxy.baseDomain}/${proxy.pathPrefix}`;
    }
    return `${scheme}://${proxy.baseDomain}/${instanceName}`;
  }
}

export const settingsService = new SettingsService();
