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
  FormLabel,
  Grid,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { DHIS2Instance } from '../types';
import { CloneInstancePayload } from '../services/dhis2Service';

export interface CloneInstanceDialogProps {
  open: boolean;
  /** Source instance being cloned. */
  source: DHIS2Instance | null;
  /** Cluster nodes to choose from for the target placement. */
  clusterNodes: string[];
  /** DHIS2 versions to choose from (defaults to source version). */
  versions: string[];
  /** Suggested next free VMID (from `dhis2Service.getNextVmid`). */
  suggestedVmid: number | null;
  /** Base domain configured for the deployment (e.g. "dhis2.example.org"). */
  baseDomain: string;
  /** Whether a submit is currently in flight. */
  submitting?: boolean;
  /** Last submit error to surface, if any. */
  errorMessage?: string | null;
  onClose: () => void;
  onSubmit: (payload: CloneInstancePayload) => void;
}

type DbStrategy = 'colocated' | 'shared-clone' | 'shared-keep';

const LOCAL_DB_HOSTS = ['', 'localhost', '127.0.0.1', '::1', 'postgres'];

function isColocatedDb(host?: string): boolean {
  return LOCAL_DB_HOSTS.includes((host ?? '').trim());
}

function generatePassword(length = 20): string {
  // Browser-safe random password (alnum + a couple of safe symbols).
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(length);
  (globalThis.crypto ?? window.crypto).getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function deriveDomain(baseDomain: string, name: string): string {
  const base = (baseDomain || '').trim();
  if (!base) return name;
  // Treat baseDomain as a wildcard parent: `<name>.<base>`.
  return `${name}.${base}`;
}

export const CloneInstanceDialog = ({
  open,
  source,
  clusterNodes,
  versions,
  suggestedVmid,
  baseDomain,
  submitting,
  errorMessage,
  onClose,
  onSubmit,
}: CloneInstanceDialogProps) => {
  const sourceIsColocated = isColocatedDb(source?.database?.host);
  const defaultStrategy: DbStrategy = sourceIsColocated
    ? 'colocated'
    : 'shared-clone';

  const [name, setName] = useState('');
  const [vmid, setVmid] = useState<number | ''>('');
  const [node, setNode] = useState('');
  const [domain, setDomain] = useState('');
  const [version, setVersion] = useState('');
  const [cpu, setCpu] = useState<number>(2);
  const [memory, setMemory] = useState<number>(4096);
  const [storage, setStorage] = useState<number>(40);
  const [dbStrategy, setDbStrategy] = useState<DbStrategy>(defaultStrategy);
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState<number>(5432);
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [adminUser, setAdminUser] = useState('postgres');
  const [adminPassword, setAdminPassword] = useState('');
  const [pauseSource, setPauseSource] = useState(true);
  const [skipCertbot, setSkipCertbot] = useState(false);
  const [email, setEmail] = useState('');

  // Re-seed defaults whenever the dialog is opened for a (possibly new) source.
  useEffect(() => {
    if (!open || !source) return;
    const targetName = `${source.name}-clone`;
    setName(targetName);
    setVmid(suggestedVmid ?? '');
    setNode(source.node);
    setDomain(deriveDomain(baseDomain, targetName));
    setVersion(source.version || (versions[0] ?? ''));
    setCpu(source.resources?.cpu ?? 2);
    setMemory(source.resources?.memory ?? 4096);
    setStorage(source.resources?.storage ?? 40);
    setDbStrategy(defaultStrategy);
    setDbHost(source.database?.host ?? '');
    setDbPort(source.database?.port ?? 5432);
    setDbName(`${targetName.replace(/[^a-zA-Z0-9_]/g, '_')}_db`);
    setDbUser(targetName.replace(/[^a-zA-Z0-9_]/g, '_'));
    setDbPassword(generatePassword());
    setAdminUser('postgres');
    setAdminPassword('');
    setPauseSource(true);
    setSkipCertbot(false);
    setEmail('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.id]);

  // Keep derived defaults in sync as the operator edits the target name.
  useEffect(() => {
    const safe = name.replace(/[^a-zA-Z0-9_]/g, '_');
    if (safe) {
      setDbName(`${safe}_db`);
      setDbUser(safe);
    }
    if (baseDomain) {
      setDomain(deriveDomain(baseDomain, name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const minStorage = source?.resources?.storage ?? 1;

  const validationError = useMemo<string | null>(() => {
    if (!source) return 'Missing source instance';
    if (!name.trim()) return 'Target name is required';
    if (typeof vmid !== 'number' || vmid <= 0) {
      return 'Target VMID must be a positive integer';
    }
    if (String(source.vmid) === String(vmid)) {
      return 'Target VMID must differ from the source VMID';
    }
    if (!node.trim()) return 'Target node is required';
    if (!domain.trim()) return 'Target FQDN/segment is required';
    if (cpu <= 0 || memory <= 0 || storage <= 0) {
      return 'CPU / memory / storage must be positive';
    }
    if (storage < minStorage) {
      return `Storage must be ≥ source rootfs (${minStorage} GB)`;
    }
    if (dbStrategy !== 'colocated' && !dbHost.trim()) {
      return 'DB host is required for shared-* strategies';
    }
    if (!dbName.trim() || !dbUser.trim()) {
      return 'DB name and DB user are required';
    }
    if (!dbPassword.trim()) return 'DB password is required';
    if (dbStrategy === 'shared-clone' && !adminPassword.trim()) {
      return 'Admin DB password is required for "Clone DB on shared server"';
    }
    return null;
  }, [
    source,
    name,
    vmid,
    node,
    domain,
    cpu,
    memory,
    storage,
    minStorage,
    dbStrategy,
    dbHost,
    dbName,
    dbUser,
    dbPassword,
    adminPassword,
  ]);

  if (!source) return null;

  const submit = () => {
    if (validationError) return;
    const payload: CloneInstancePayload = {
      name: name.trim(),
      hostname: name.trim(),
      node: node.trim(),
      vmid: Number(vmid),
      domain: domain.trim(),
      version: version.trim() || undefined,
      resources: { cpu, memory, storage },
      dbStrategy,
      database: {
        host: dbHost.trim(),
        port: dbPort,
        name: dbName.trim(),
        user: dbUser.trim(),
        password: dbPassword,
      },
      databaseAdmin:
        dbStrategy === 'shared-clone'
          ? { user: adminUser.trim() || 'postgres', password: adminPassword }
          : undefined,
      pauseSource,
      skipCertbot,
      email: email.trim() || undefined,
    };
    onSubmit(payload);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Clone to new environment — from {source.name} (vmid {source.vmid})
      </DialogTitle>
      <DialogContent>
        <Box mb={2}>
          <Typography variant="body2" color="textSecondary">
            Duplicates the underlying LXC via Proxmox, then reconfigures the
            clone's database connection and central nginx vhost so it runs
            independently as a dev / test / staging environment.
          </Typography>
        </Box>

        {(validationError || errorMessage) && (
          <Box mb={2}>
            <Alert severity={errorMessage ? 'error' : 'warning'}>
              {errorMessage || validationError}
            </Alert>
          </Box>
        )}

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Target name"
              fullWidth
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <TextField
              label="Target VMID"
              fullWidth
              type="number"
              value={vmid}
              onChange={e =>
                setVmid(e.target.value === '' ? '' : Number(e.target.value))
              }
              helperText={
                suggestedVmid ? `Suggested: ${suggestedVmid}` : undefined
              }
            />
          </Grid>
          <Grid item xs={6} sm={3}>
            <FormControl fullWidth>
              <InputLabel>Target node</InputLabel>
              <Select
                value={node}
                onChange={e => setNode(String(e.target.value))}
              >
                {clusterNodes.length === 0 && (
                  <MenuItem value={source.node}>{source.node}</MenuItem>
                )}
                {clusterNodes.map(n => (
                  <MenuItem key={n} value={n}>
                    {n}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} sm={8}>
            <TextField
              label="FQDN / segment"
              fullWidth
              value={domain}
              onChange={e => setDomain(e.target.value)}
              helperText='Public hostname for the clone (e.g. "test.dhis2.example.org")'
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <FormControl fullWidth>
              <InputLabel>DHIS2 version</InputLabel>
              <Select
                value={version}
                onChange={e => setVersion(String(e.target.value))}
              >
                {(versions.length === 0
                  ? [source.version].filter(Boolean)
                  : versions
                ).map(v => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={4}>
            <TextField
              label="vCPU"
              fullWidth
              type="number"
              value={cpu}
              onChange={e => setCpu(Number(e.target.value) || 0)}
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              label="Memory (MB)"
              fullWidth
              type="number"
              value={memory}
              onChange={e => setMemory(Number(e.target.value) || 0)}
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              label="Storage (GB)"
              fullWidth
              type="number"
              value={storage}
              onChange={e => setStorage(Number(e.target.value) || 0)}
              helperText={`Min ${minStorage} GB (grow only)`}
            />
          </Grid>

          <Grid item xs={12}>
            <FormControl component="fieldset">
              <FormLabel component="legend">Database strategy</FormLabel>
              <RadioGroup
                value={dbStrategy}
                onChange={e => setDbStrategy(e.target.value as DbStrategy)}
              >
                <FormControlLabel
                  value="colocated"
                  control={<Radio />}
                  disabled={!sourceIsColocated}
                  label={
                    sourceIsColocated
                      ? 'Co-located — DB lives in source LXC; pct clone copies it automatically'
                      : 'Co-located — disabled (source DB is on a remote server)'
                  }
                />
                <FormControlLabel
                  value="shared-clone"
                  control={<Radio />}
                  disabled={sourceIsColocated}
                  label="Shared remote DB — CREATE DATABASE … TEMPLATE <src> on the same server"
                />
                <FormControlLabel
                  value="shared-keep"
                  control={<Radio />}
                  disabled={sourceIsColocated}
                  label="Shared remote DB — keep pointing at source DB (dangerous, read/write to source)"
                />
              </RadioGroup>
            </FormControl>
          </Grid>

          {dbStrategy === 'shared-keep' && (
            <Grid item xs={12}>
              <Alert severity="warning">
                The clone will read and WRITE to the source database. Only use
                this for short-lived experiments where you accept data
                cross-contamination with the source instance.
              </Alert>
            </Grid>
          )}

          <Grid item xs={12} sm={6}>
            <TextField
              label="New DB name"
              fullWidth
              value={dbName}
              onChange={e => setDbName(e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="New DB user"
              fullWidth
              value={dbUser}
              onChange={e => setDbUser(e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={8}>
            <TextField
              label="New DB password"
              fullWidth
              value={dbPassword}
              onChange={e => setDbPassword(e.target.value)}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <Button
              variant="outlined"
              onClick={() => setDbPassword(generatePassword())}
              fullWidth
            >
              Regenerate
            </Button>
          </Grid>

          {dbStrategy !== 'colocated' && (
            <>
              <Grid item xs={12} sm={8}>
                <TextField
                  label="DB host"
                  fullWidth
                  value={dbHost}
                  onChange={e => setDbHost(e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="DB port"
                  fullWidth
                  type="number"
                  value={dbPort}
                  onChange={e => setDbPort(Number(e.target.value) || 5432)}
                />
              </Grid>
            </>
          )}

          {dbStrategy === 'shared-clone' && (
            <>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="DB admin user"
                  fullWidth
                  value={adminUser}
                  onChange={e => setAdminUser(e.target.value)}
                  helperText="Role used to CREATE DATABASE on the shared server"
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="DB admin password"
                  fullWidth
                  type="password"
                  value={adminPassword}
                  onChange={e => setAdminPassword(e.target.value)}
                />
              </Grid>
            </>
          )}

          <Grid item xs={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={pauseSource}
                  onChange={e => setPauseSource(e.target.checked)}
                />
              }
              label="Briefly shut down source for a consistent clone (recommended)"
            />
          </Grid>
          <Grid item xs={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={skipCertbot}
                  onChange={e => setSkipCertbot(e.target.checked)}
                />
              }
              label="Skip Let's Encrypt cert request (e.g. for internal-only environments)"
            />
          </Grid>
          {!skipCertbot && (
            <Grid item xs={12}>
              <TextField
                label="Contact email (Let's Encrypt)"
                fullWidth
                value={email}
                onChange={e => setEmail(e.target.value)}
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
          onClick={submit}
          variant="contained"
          color="primary"
          disabled={Boolean(validationError) || submitting}
        >
          {submitting ? 'Cloning…' : 'Clone instance'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
