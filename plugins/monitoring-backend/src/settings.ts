import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Change the Monitoring plugin's shared settings (Settings tab). Reading them is open to every
 * signed-in user. Grant it with a role on the RBAC Administration page, or to super users.
 */
export const monitoringSettingsUpdatePermission = createPermission({
  name: 'monitoring.settings.update',
  attributes: { action: 'update' },
});

export const monitoringPermissions = [monitoringSettingsUpdatePermission];

type Rule =
  | { type: 'number'; min: number; max?: number }
  | { type: 'currency' };

/**
 * The settings that can be changed, by their app-config key under `monitoring.`. A saved value
 * overrides app-config; removing it falls back to app-config again.
 */
export const SETTINGS: Record<string, Rule> = {
  'costs.currency': { type: 'currency' },
  'costs.monthlyInfrastructureCost': { type: 'number', min: 0 },
  'costs.split.cpu': { type: 'number', min: 0, max: 1 },
  'costs.split.memory': { type: 'number', min: 0, max: 1 },
  'costs.split.storage': { type: 'number', min: 0, max: 1 },
  'costs.split.network': { type: 'number', min: 0, max: 1 },
  'costs.split.backup': { type: 'number', min: 0, max: 1 },
  'costs.rates.cpuCoreMonth': { type: 'number', min: 0 },
  'costs.rates.memoryGbMonth': { type: 'number', min: 0 },
  'costs.rates.storageGbMonth': { type: 'number', min: 0 },
  'costs.rates.networkGb': { type: 'number', min: 0 },
  'costs.rates.backupGbMonth': { type: 'number', min: 0 },
  'costs.rates.guestMonth': { type: 'number', min: 0 },
  'costs.electricity.tariffPerKwh': { type: 'number', min: 0 },
  'costs.electricity.pue': { type: 'number', min: 1, max: 3 },
  'costs.electricity.co2KgPerKwh': { type: 'number', min: 0, max: 2 },
};

export type SettingValue = number | string;

/**
 * Checks a change: `{ key: value }` to save, `{ key: null }` to remove. Returns the problems, if any.
 */
export function validate(changes: unknown): string[] {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return ['expected an object of setting: value'];
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(
    changes as Record<string, unknown>,
  )) {
    const rule = SETTINGS[key];
    if (!rule) {
      problems.push(`${key}: not a setting`);
      continue;
    }
    if (value === null) continue;
    if (rule.type === 'currency') {
      if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
        problems.push(`${key}: a three-letter currency code, such as ZMW`);
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${key}: a number`);
    } else if (
      value < rule.min ||
      (rule.max !== undefined && value > rule.max)
    ) {
      problems.push(
        rule.max === undefined
          ? `${key}: ${rule.min} or more`
          : `${key}: between ${rule.min} and ${rule.max}`,
      );
    }
  }
  return problems;
}
