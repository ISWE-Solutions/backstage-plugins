import {
  ConfigApi,
  configApiRef,
  useApiHolder,
} from '@backstage/core-plugin-api';
import { DHIS2PluginSettings, DEFAULT_SETTINGS } from '../types';

const STORAGE_KEY = 'dhis2-plugin-settings';

function normalizePrivateKeyPath(pathLike?: string): string | undefined {
  const p = (pathLike ?? '').trim();
  if (!p) return undefined;
  return p.endsWith('.pub') ? p.slice(0, -4) : p;
}

/**
 * Applies app-config defaults to the shared settingsService. Call at the top
 * of every exported component that reads settings, before anything else.
 */
export function useConfiguredSettingsDefaults(): void {
  const config = useApiHolder().get(configApiRef);
  if (config) settingsService.configure(config);
}

/**
 * Frontend persistence for the DHIS2 plugin settings.
 *
 * Settings are kept in localStorage for now; once a backend plugin is
 * available the same shape can be PUT/GET against `/api/dhis2/settings`.
 */
export class SettingsService {
  private defaults: DHIS2PluginSettings = DEFAULT_SETTINGS;
  private staleValues: {
    proxmox?: Record<string, string[]>;
    proxy?: Record<string, string[]>;
  } = {};
  private configuredFrom?: ConfigApi;

  /**
   * Layers `dhis2.settingsDefaults` from app-config over DEFAULT_SETTINGS, so
   * a deployment can ship its own defaults (cluster URL, proxy host, domains)
   * without every browser having to fill in the settings panels first.
   */
  configure(config: ConfigApi): void {
    if (this.configuredFrom === config) return;
    this.configuredFrom = config;
    const c = config.getOptionalConfig('dhis2.settingsDefaults');
    const section = (key: string) => c?.getOptionalConfig(key)?.get<{}>() ?? {};
    this.defaults = {
      proxmox: { ...DEFAULT_SETTINGS.proxmox, ...section('proxmox') },
      proxy: { ...DEFAULT_SETTINGS.proxy, ...section('proxy') },
      dhis2: { ...DEFAULT_SETTINGS.dhis2, ...section('dhis2') },
    };
    this.staleValues = section('replaceStoredValues');
  }

  /** DEFAULT_SETTINGS with any app-config overrides applied */
  getDefaults(): DHIS2PluginSettings {
    return this.defaults;
  }

  load(): DHIS2PluginSettings {
    const defaults = this.defaults;
    try {
      const raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(STORAGE_KEY)
          : null;
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<DHIS2PluginSettings>;
      // Deep-merge with defaults so new fields don't break stored settings.
      const merged: DHIS2PluginSettings = {
        proxmox: { ...defaults.proxmox, ...(parsed.proxmox ?? {}) },
        proxy: { ...defaults.proxy, ...(parsed.proxy ?? {}) },
        dhis2: { ...defaults.dhis2, ...(parsed.dhis2 ?? {}) },
      };
      merged.proxy.sshKeyPath =
        normalizePrivateKeyPath(merged.proxy.sshKeyPath) ??
        merged.proxy.sshKeyPath;
      // Migrate stale placeholder values from older builds to the current
      // defaults so the UI reflects the new defaults without forcing users
      // to clear localStorage manually.
      // Deployments can list further values (e.g. a host that shipped as a
      // default by mistake) under dhis2.settingsDefaults.replaceStoredValues.
      const stalePlaceholders: Record<keyof typeof merged.proxy, string[]> = {
        baseDomain: [DEFAULT_SETTINGS.proxy.baseDomain],
        host: [DEFAULT_SETTINGS.proxy.host],
        sshKeyPath: ['/var/lib/backstage/.ssh/id_ed25519'],
        // Old Debian/Ubuntu sites-available layout — superseded by the
        // single conf.d directory (which nginx auto-includes).
        nginxConfigPath: ['/etc/nginx/sites-available'],
      } as any;
      Object.entries(this.staleValues.proxy ?? {}).forEach(([key, values]) => {
        (stalePlaceholders as any)[key] = [
          ...((stalePlaceholders as any)[key] ?? []),
          ...values,
        ];
      });
      (
        Object.keys(stalePlaceholders) as Array<keyof typeof merged.proxy>
      ).forEach(key => {
        const current = merged.proxy[key] as unknown as string;
        if (stalePlaceholders[key].includes(current)) {
          (merged.proxy as any)[key] = defaults.proxy[key];
        }
      });
      // A stored apiUrl that is still the shipped placeholder, or one the
      // deployment lists as unreachable (replaceStoredValues.proxmox.apiUrl),
      // is corrected to the configured default — otherwise every direct
      // (non-proxied) Proxmox call from this browser times out. Applies
      // regardless of useBackstageProxy, since users may flip that toggle
      // off later.
      const staleApiUrls = [
        DEFAULT_SETTINGS.proxmox.apiUrl,
        ...(this.staleValues.proxmox?.apiUrl ?? []),
      ];
      if (staleApiUrls.includes(merged.proxmox.apiUrl)) {
        merged.proxmox.apiUrl = defaults.proxmox.apiUrl;
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
          parsed.proxmox.apiUrl === defaults.proxmox.apiUrl)
      ) {
        merged.proxmox.verifyTls = defaults.proxmox.verifyTls;
      }

      // Multi-cluster migration: ensure at least one named cluster profile.
      // `proxmox` always mirrors the active profile so existing consumers
      // (create/clone/update dialogs) keep reading a single cluster.
      const stored = Array.isArray(parsed.proxmoxClusters)
        ? parsed.proxmoxClusters
        : [];
      if (stored.length === 0) {
        merged.proxmoxClusters = [
          { id: 'default', name: 'Default', ...merged.proxmox },
        ];
        merged.activeProxmoxClusterId = 'default';
      } else {
        merged.proxmoxClusters = stored.map(c => ({
          ...defaults.proxmox,
          ...c,
        }));
        const active =
          merged.proxmoxClusters.find(
            c => c.id === parsed.activeProxmoxClusterId,
          ) ?? merged.proxmoxClusters[0];
        merged.activeProxmoxClusterId = active.id;
        const { id: _id, name: _name, ...activeSettings } = active;
        merged.proxmox = activeSettings;
      }
      return merged;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load DHIS2 plugin settings, using defaults', e);
      return defaults;
    }
  }

  save(settings: DHIS2PluginSettings): void {
    if (typeof window === 'undefined') return;
    // Keep the active cluster profile in sync with `proxmox` before saving.
    const clusters = (settings.proxmoxClusters ?? []).map(c =>
      c.id === settings.activeProxmoxClusterId
        ? { ...c, ...settings.proxmox }
        : c,
    );
    const normalized: DHIS2PluginSettings = {
      ...settings,
      proxmoxClusters: clusters.length ? clusters : undefined,
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
    return this.defaults;
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
