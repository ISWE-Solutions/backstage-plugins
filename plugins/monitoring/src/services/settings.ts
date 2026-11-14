import { createContext, useContext } from 'react';
import { ConfigReader } from '@backstage/config';
import { ConfigApi, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';

/**
 * Shared settings from @iswesolutions/plugin-monitoring-backend (Settings tab). A saved setting
 * overrides app-config (`monitoring.<key>`); without the backend, app-config alone applies.
 */
export type SettingValue = number | string;

export interface StoredSetting {
  value: SettingValue;
  updatedBy: string;
  updatedAt: string;
}

export interface SettingsState {
  /** false when the backend isn't installed (or not reachable) */
  available: boolean;
  settings: Record<string, StoredSetting>;
  canEdit: boolean;
  /** why the settings couldn't be loaded, when not available */
  error?: string;
}

export async function loadSettings(apis: {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
}): Promise<SettingsState> {
  try {
    const base = await apis.discoveryApi.getBaseUrl('monitoring');
    const res = await apis.fetchApi.fetch(`${base}/settings`);
    if (!res.ok) {
      return {
        available: false,
        settings: {},
        canEdit: false,
        error: `HTTP ${res.status}`,
      };
    }
    const body = await res.json();
    return {
      available: true,
      settings: body.settings ?? {},
      canEdit: Boolean(body.canEdit),
    };
  } catch (e: any) {
    return {
      available: false,
      settings: {},
      canEdit: false,
      error: String(e?.message ?? e),
    };
  }
}

/** Saves `{ key: value }` and removes `{ key: null }`; returns the settings after the change. */
export async function saveSettings(
  apis: { discoveryApi: DiscoveryApi; fetchApi: FetchApi },
  changes: Record<string, SettingValue | null>,
): Promise<SettingsState> {
  const base = await apis.discoveryApi.getBaseUrl('monitoring');
  const res = await apis.fetchApi.fetch(`${base}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      message = b?.error?.message ?? b?.error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  const body = await res.json();
  return {
    available: true,
    settings: body.settings ?? {},
    canEdit: Boolean(body.canEdit),
  };
}

/** `{ 'costs.split.cpu': 0.4 }` -> `{ monitoring: { costs: { split: { cpu: 0.4 } } } }` */
export function nest(flat: Record<string, SettingValue>): Record<string, any> {
  const root: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = ['monitoring', ...key.split('.')];
    let node = root;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= {};
      node = node[p];
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

/** app-config with the saved settings on top. */
export function effectiveConfig(
  configApi: ConfigApi,
  settings: Record<string, StoredSetting>,
): ConfigApi {
  const saved = Object.fromEntries(
    Object.entries(settings).map(([k, s]) => [k, s.value]),
  );
  if (Object.keys(saved).length === 0) return configApi;
  return ConfigReader.fromConfigs([
    { context: 'app-config', data: (configApi.getOptional() as any) ?? {} },
    { context: 'monitoring settings', data: nest(saved) },
  ]);
}

export interface SettingsContextValue {
  state: SettingsState;
  /** app-config with the saved settings on top */
  config: ConfigApi;
  setState: (s: SettingsState) => void;
}

export const SettingsContext = createContext<SettingsContextValue | undefined>(
  undefined,
);

/** The effective config for cost and electricity, or undefined outside the Monitoring page. */
export const useMonitoringSettings = () => useContext(SettingsContext);
