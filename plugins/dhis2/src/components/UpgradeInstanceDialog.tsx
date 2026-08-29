import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { DHIS2Instance } from '../types';
import { UpgradeInstancePayload } from '../services/dhis2Service';

export interface UpgradeInstanceDialogProps {
  open: boolean;
  /** Instance being upgraded. */
  instance: DHIS2Instance | null;
  /** DHIS2 versions to choose from. */
  versions: string[];
  /** Whether a submit is currently in flight. */
  submitting?: boolean;
  /** Last submit error to surface, if any. */
  errorMessage?: string | null;
  /**
   * Optional target version to pre-select (e.g. when the dialog is
   * opened from a hotfix chip that already knows which patch to apply).
   * Overrides the default "highest > current" heuristic.
   */
  defaultVersion?: string;
  onClose: () => void;
  onSubmit: (payload: UpgradeInstancePayload) => void;
}

/** Build the default releases.dhis2.org URL for a given version label. */
function deriveWarUrl(version: string): string {
  const v = (version || '').trim().replace(/^2\./, '');
  if (!v) return '';
  const parts = v.split('.');
  const major = parts[0];
  const patch = parts[1] ?? '0';
  const hotfix = parts[2] ?? '0';
  if (!/^\d+$/.test(major)) return '';
  return `https://releases.dhis2.org/${major}/dhis2-stable-${major}.${patch}.${hotfix}.war`;
}

function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    (v || '')
      .trim()
      .replace(/^2\./, '')
      .split('.')
      .map(p => parseInt(p, 10) || 0);
  const av = norm(a);
  const bv = norm(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const da = av[i] ?? 0;
    const db = bv[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export const UpgradeInstanceDialog = ({
  open,
  instance,
  versions,
  submitting,
  errorMessage,
  defaultVersion,
  onClose,
  onSubmit,
}: UpgradeInstanceDialogProps) => {
  const currentVersion = (instance?.version ?? '').trim();

  // Default the target to the caller-supplied hint when provided (e.g.
  // hotfix chip), otherwise the latest version greater than the current
  // one; falling back to the latest entry in the catalogue.
  const defaultTarget = useMemo(() => {
    const hint = (defaultVersion ?? '').trim();
    if (hint) return hint;
    if (!versions || versions.length === 0) return currentVersion;
    const sorted = [...versions].sort(compareVersions);
    const newer = sorted.filter(v => compareVersions(v, currentVersion) > 0);
    return (newer[newer.length - 1] ?? sorted[sorted.length - 1] ?? '').trim();
  }, [versions, currentVersion, defaultVersion]);

  const [toVersion, setToVersion] = useState<string>(defaultTarget);
  const [warUrl, setWarUrl] = useState<string>(deriveWarUrl(defaultTarget));
  const [warUrlEdited, setWarUrlEdited] = useState<boolean>(false);
  const [warFile, setWarFile] = useState<string>('');
  const [backupDb, setBackupDb] = useState<boolean>(true);
  const [dbPassword, setDbPassword] = useState<string>(
    instance?.database?.password ?? '',
  );

  // Re-seed dialog state whenever it (re)opens for a new instance.
  useEffect(() => {
    if (!open) return;
    setToVersion(defaultTarget);
    setWarUrl(deriveWarUrl(defaultTarget));
    setWarUrlEdited(false);
    setWarFile('');
    setBackupDb(true);
    setDbPassword(instance?.database?.password ?? '');
  }, [open, defaultTarget, instance]);

  // Keep the URL field in sync with the version dropdown until the
  // operator edits it manually.
  useEffect(() => {
    if (warUrlEdited) return;
    setWarUrl(deriveWarUrl(toVersion));
  }, [toVersion, warUrlEdited]);

  const versionWarning = useMemo(() => {
    if (!toVersion || !currentVersion) return null;
    const cmp = compareVersions(toVersion, currentVersion);
    if (cmp < 0) {
      return `Target version ${toVersion} is OLDER than the currently deployed ${currentVersion}. Downgrades are only supported when the DB schema is compatible.`;
    }
    if (cmp === 0) {
      return `Target version ${toVersion} matches the currently deployed version. The WAR will still be re-deployed.`;
    }
    return null;
  }, [toVersion, currentVersion]);

  const dbName = instance?.database?.name ?? '';
  const dbUser = instance?.database?.user ?? '';
  const dbMissing =
    backupDb && (!dbName || !dbUser || !dbPassword || dbPassword.trim() === '');

  const canSubmit =
    !submitting && Boolean(toVersion) && !dbMissing && instance !== null;

  const handleSubmit = () => {
    if (!instance || !canSubmit) return;
    const payload: UpgradeInstancePayload = {
      toVersion: toVersion.trim(),
      warUrl: warUrl.trim() ? warUrl.trim() : undefined,
      warFile: warFile.trim() ? warFile.trim() : undefined,
      backupDb,
      database: backupDb
        ? {
            host: instance.database?.host,
            port: instance.database?.port,
            name: dbName,
            user: dbUser,
            password: dbPassword,
          }
        : undefined,
    };
    onSubmit(payload);
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        Upgrade DHIS2 WAR
        {instance ? ` — ${instance.name}` : ''}
      </DialogTitle>
      <DialogContent>
        <Box mb={2}>
          <Typography variant="body2" color="textSecondary">
            Stops Tomcat inside the LXC, archives the current WAR under{' '}
            <code>/opt/dhis2/backups/pre-upgrade-&lt;timestamp&gt;/</code>,
            pushes the new WAR, and restarts Tomcat with a health probe. Plan
            for ~1–2 minutes of downtime while DHIS2 re-explodes.
          </Typography>
        </Box>

        {currentVersion && (
          <Box mb={2}>
            <Typography variant="body2">
              Currently deployed: <strong>DHIS2 {currentVersion}</strong>
            </Typography>
          </Box>
        )}

        {errorMessage && (
          <Box mb={2}>
            <Alert severity="error">{errorMessage}</Alert>
          </Box>
        )}

        {versionWarning && (
          <Box mb={2}>
            <Alert severity="warning">{versionWarning}</Alert>
          </Box>
        )}

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <FormControl variant="outlined" fullWidth size="small">
              <InputLabel>Target version</InputLabel>
              <Select
                label="Target version"
                value={toVersion}
                onChange={e => setToVersion(String(e.target.value))}
              >
                {(versions ?? []).map(v => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
                {toVersion && !(versions ?? []).includes(toVersion) && (
                  <MenuItem value={toVersion}>{toVersion} (custom)</MenuItem>
                )}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Or type a version"
              variant="outlined"
              size="small"
              fullWidth
              value={toVersion}
              onChange={e => setToVersion(e.target.value)}
              placeholder="2.41.3 or 41.2.0"
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              label="WAR download URL"
              variant="outlined"
              size="small"
              fullWidth
              value={warUrl}
              onChange={e => {
                setWarUrl(e.target.value);
                setWarUrlEdited(true);
              }}
              helperText="Derived from the target version. Override to point at an internal mirror."
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              label="Pre-staged WAR on PVE host (optional)"
              variant="outlined"
              size="small"
              fullWidth
              value={warFile}
              onChange={e => setWarFile(e.target.value)}
              placeholder="/var/lib/vz/dhis2-uploads/dhis2-stable-41.2.0.war"
              helperText="If set, the playbook skips the download and uses this file instead."
            />
          </Grid>

          <Grid item xs={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={backupDb}
                  onChange={e => setBackupDb(e.target.checked)}
                  color="primary"
                />
              }
              label="Take a pg_dump backup before swapping the WAR"
            />
          </Grid>

          {backupDb && (
            <Grid item xs={12}>
              <TextField
                label="Database password (for pg_dump)"
                type="password"
                variant="outlined"
                size="small"
                fullWidth
                value={dbPassword}
                onChange={e => setDbPassword(e.target.value)}
                helperText={
                  dbName
                    ? `Used to dump "${dbName}" as user "${dbUser}".`
                    : 'Required so pg_dump can authenticate.'
                }
              />
            </Grid>
          )}
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          color="primary"
          variant="contained"
          disabled={!canSubmit}
        >
          {submitting ? 'Upgrading…' : 'Start upgrade'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
