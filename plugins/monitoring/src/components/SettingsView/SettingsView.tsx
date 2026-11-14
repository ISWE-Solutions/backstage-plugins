import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  saveSettings,
  SettingValue,
  useMonitoringSettings,
} from '../../services/settings';

type Field = {
  key: string;
  label: string;
  help: string;
  /** shown after the input */
  unit?: (currency: string) => string;
  text?: boolean;
};

const GROUPS: { title: string; note?: string; fields: Field[] }[] = [
  {
    title: 'Currency',
    fields: [
      {
        key: 'costs.currency',
        label: 'Currency',
        help: 'Three-letter code, such as ZMW or USD.',
        text: true,
      },
    ],
  },
  {
    title: 'Electricity',
    note: 'Shown on Cost Insights beside the guests’ costs, not added to them.',
    fields: [
      {
        key: 'costs.electricity.tariffPerKwh',
        label: 'Price of a kWh',
        help: 'What a kilowatt-hour costs.',
        unit: c => `${c} per kWh`,
      },
      {
        key: 'costs.electricity.pue',
        label: 'PUE',
        help: 'Facility energy ÷ IT energy (cooling, power distribution), 1 to 3. 1 leaves it out; 1.5 is typical.',
      },
      {
        key: 'costs.electricity.co2KgPerKwh',
        label: 'CO₂ per kWh',
        help: 'The grid’s emission factor.',
        unit: () => 'kg per kWh',
      },
    ],
  },
  {
    title: 'Cost recovery',
    note: 'What the infrastructure costs per month, shared over the pools; rates are derived from it and the cluster’s capacity. The shares should add up to 1.',
    fields: [
      {
        key: 'costs.monthlyInfrastructureCost',
        label: 'Infrastructure per month',
        help: 'Hosting, hardware, power, licences: all in.',
        unit: c => `${c} per month`,
      },
      { key: 'costs.split.cpu', label: 'CPU share', help: '0 to 1' },
      { key: 'costs.split.memory', label: 'Memory share', help: '0 to 1' },
      { key: 'costs.split.storage', label: 'Storage share', help: '0 to 1' },
      { key: 'costs.split.network', label: 'Network share', help: '0 to 1' },
      { key: 'costs.split.backup', label: 'Backup share', help: '0 to 1' },
    ],
  },
  {
    title: 'Price list',
    note: 'Explicit prices; each one overrides the rate derived from the monthly cost.',
    fields: [
      {
        key: 'costs.rates.cpuCoreMonth',
        label: 'CPU',
        help: 'Per core used, per month.',
        unit: c => `${c} / core-month`,
      },
      {
        key: 'costs.rates.memoryGbMonth',
        label: 'Memory',
        help: 'Per GiB, per month.',
        unit: c => `${c} / GiB-month`,
      },
      {
        key: 'costs.rates.storageGbMonth',
        label: 'Storage',
        help: 'Per GiB allotted, per month.',
        unit: c => `${c} / GiB-month`,
      },
      {
        key: 'costs.rates.networkGb',
        label: 'Network',
        help: 'Per GiB in and out.',
        unit: c => `${c} / GiB`,
      },
      {
        key: 'costs.rates.backupGbMonth',
        label: 'Backups',
        help: 'Per GiB on the backup server, per month.',
        unit: c => `${c} / GiB-month`,
      },
      {
        key: 'costs.rates.guestMonth',
        label: 'Fixed fee',
        help: 'Per guest, per month.',
        unit: c => `${c} / guest-month`,
      },
    ],
  },
];

/** The shared settings: everyone sees them, admins (monitoring.settings.update) change them. */
export const SettingsView = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const ctx = useMonitoringSettings();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    severity: 'success' | 'error';
    text: string;
  }>();

  if (!ctx) return null;
  const { state } = ctx;
  if (!state.available) {
    return (
      <Box p={3}>
        <Alert severity="info">
          Shared settings need{' '}
          <code>@iswesolutions/plugin-monitoring-backend</code> in the Backstage
          backend ({state.error}). Until then the tabs use app-config (
          <code>monitoring.costs</code>).
        </Alert>
      </Box>
    );
  }

  const defaultOf = (key: string) =>
    configApi.getOptional(`monitoring.${key}`) as SettingValue | undefined;
  const savedOf = (key: string) => state.settings[key];
  const savedText = (key: string) =>
    savedOf(key) !== undefined ? String(savedOf(key).value) : '';
  /** what the field shows: the edit in progress, else the saved value, else empty (app-config applies) */
  const shown = (key: string) => (key in draft ? draft[key] : savedText(key));
  const currency = String(
    shown('costs.currency') || defaultOf('costs.currency') || 'USD',
  );
  const changed = Object.keys(draft).filter(k => draft[k] !== savedText(k));
  const splitSum = ['cpu', 'memory', 'storage', 'network', 'backup']
    .map(p =>
      Number(
        shown(`costs.split.${p}`) ||
          defaultOf(`costs.split.${p}`) ||
          {
            cpu: 0.35,
            memory: 0.35,
            storage: 0.15,
            network: 0.1,
            backup: 0.05,
          }[p],
      ),
    )
    .reduce((a, b) => a + b, 0);

  const save = async () => {
    const changes: Record<string, SettingValue | null> = {};
    for (const k of changed) {
      const v = draft[k].trim();
      const field = GROUPS.flatMap(g => g.fields).find(f => f.key === k);
      if (v === '') changes[k] = null;
      else changes[k] = field?.text ? v.toUpperCase() : Number(v);
    }
    setSaving(true);
    setMessage(undefined);
    try {
      ctx.setState(await saveSettings({ discoveryApi, fetchApi }, changes));
      setDraft({});
      setMessage({
        severity: 'success',
        text: `Saved ${changed.length} setting${
          changed.length === 1 ? '' : 's'
        }; the other tabs use them now.`,
      });
    } catch (e: any) {
      setMessage({ severity: 'error', text: `Not saved: ${e?.message ?? e}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box p={3}>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        mb={2}
        style={{ gap: 16 }}
      >
        <Typography variant="h4" style={{ flexGrow: 1 }}>
          Settings
        </Typography>
        {state.canEdit && (
          <>
            <Button
              disabled={!changed.length || saving}
              onClick={() => setDraft({})}
            >
              Discard
            </Button>
            <Button
              variant="contained"
              color="primary"
              disabled={!changed.length || saving}
              onClick={save}
            >
              {saving
                ? 'Saving…'
                : `Save${changed.length ? ` (${changed.length})` : ''}`}
            </Button>
          </>
        )}
      </Box>
      <Typography variant="body2" color="textSecondary" paragraph>
        Shared by everyone: a saved value overrides app-config; empty a field to
        go back to app-config (shown greyed in the field).
      </Typography>
      {!state.canEdit && (
        <Alert severity="info" style={{ marginBottom: 16 }}>
          Read-only: changing these needs the{' '}
          <code>monitoring.settings.update</code> permission (RBAC
          Administration page).
        </Alert>
      )}
      {message && (
        <Alert
          severity={message.severity}
          style={{ marginBottom: 16 }}
          onClose={() => setMessage(undefined)}
        >
          {message.text}
        </Alert>
      )}
      <Grid container spacing={3}>
        {GROUPS.map(group => (
          <Grid item xs={12} md={6} key={group.title}>
            <Card style={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6">{group.title}</Typography>
                {group.note && (
                  <Typography variant="body2" color="textSecondary" paragraph>
                    {group.note}
                  </Typography>
                )}
                {group.title === 'Cost recovery' &&
                  Math.abs(splitSum - 1) > 0.001 && (
                    <Alert severity="warning" style={{ marginBottom: 8 }}>
                      The shares add up to {splitSum.toFixed(2)}, not 1.
                    </Alert>
                  )}
                {group.fields.map(f => {
                  const saved = savedOf(f.key);
                  const def = defaultOf(f.key);
                  return (
                    <TextField
                      key={f.key}
                      id={`monitoring-setting-${f.key.replace(/\./g, '-')}`}
                      fullWidth
                      margin="dense"
                      variant="outlined"
                      label={f.label}
                      type={f.text ? 'text' : 'number'}
                      inputProps={
                        f.text ? { maxLength: 3 } : { step: 'any', min: 0 }
                      }
                      disabled={!state.canEdit}
                      value={shown(f.key)}
                      placeholder={def !== undefined ? String(def) : 'not set'}
                      onChange={e =>
                        setDraft(d => ({ ...d, [f.key]: e.target.value }))
                      }
                      InputLabelProps={{ shrink: true }}
                      InputProps={{
                        endAdornment: f.unit ? (
                          <Typography
                            variant="caption"
                            color="textSecondary"
                            style={{ whiteSpace: 'nowrap' }}
                          >
                            {f.unit(currency)}
                          </Typography>
                        ) : undefined,
                      }}
                      helperText={
                        saved
                          ? `${f.help} Saved by ${saved.updatedBy.replace(
                              /^user:[^/]+\//,
                              '',
                            )}, ${new Date(saved.updatedAt).toLocaleString()}.`
                          : `${f.help}${
                              def !== undefined ? ` app-config: ${def}.` : ''
                            }`
                      }
                    />
                  );
                })}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};
