import { useEffect, useState } from 'react';
import {
  Box,
  Grid,
  Typography,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  RadioGroup,
  Radio,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  Select,
  Switch,
  Checkbox,
  InputAdornment,
  Tooltip,
  Divider,
  CircularProgress,
  makeStyles,
} from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import SettingsBackupRestoreIcon from '@material-ui/icons/SettingsBackupRestore';
import VpnKeyIcon from '@material-ui/icons/VpnKey';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import { Alert } from '@material-ui/lab';
import {
  fetchApiRef,
  useApi,
  discoveryApiRef,
} from '@backstage/core-plugin-api';
import {
  CreateInstanceRequest,
  DHIS2Instance,
  ProxmoxNode,
  ProxyServerSettings,
  DHIS2DefaultsSettings,
  RestoreSource,
} from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { validateRestoreSource } from '../services/restoreService';
import { RestoreSourcePicker } from './RestoreSourcePicker';

// Cryptographically strong password generator: characters drawn from a
// URL-safe alphabet that includes a few symbols Postgres accepts in passwords.
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%*';
function generateStrongPassword(length = 13): string {
  const bytes = new Uint32Array(length);
  (globalThis.crypto ?? (window as any).crypto).getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

const useStyles = makeStyles(theme => ({
  formField: {
    marginBottom: theme.spacing(2),
  },
}));

// Default `dhis.conf` Jinja template. Kept verbatim in sync with
// plugins/dhis2/ansible/roles/dhis2/templates/dhis.conf.j2 so that the
// in-dialog editor opens with the exact content the playbook would render
// if no override were provided.
export const DEFAULT_DHIS_CONF_TEMPLATE = `{# Rendered by the dhis2 Ansible role. Do not edit by hand. #}
{# Reference: https://docs.dhis2.org/en/manage/performing-system-administration/dhis-core-version-master/installation.html #}

# Database connection
connection.dialect = org.hibernate.dialect.PostgreSQLDialect
connection.driver_class = org.postgresql.Driver
connection.url = jdbc:postgresql://{{ dhis2_db_host }}:{{ dhis2_db_port }}/{{ dhis2_db_name }}
connection.username = {{ dhis2_db_user }}
connection.password = {{ dhis2_db_password }}

# Database pool
connection.pool.max_size = 80
connection.pool.min_size = 10

# Server configuration
server.base.url = {{ dhis2_server_base_url }}

# File storage
filestore.provider = filesystem
filestore.container = {{ dhis2_files_dir }}

# Analytics
analytics.cache.expiration = 3600

# System monitoring (left empty — populated by ops if/when needed).
system.monitoring.url =
system.monitoring.username =
system.monitoring.password =
`;

export interface CreateInstanceSubmitPayload {
  request: CreateInstanceRequest;
  derivedDomain: string;
  proxySettings: ProxyServerSettings;
  dhis2Settings: DHIS2DefaultsSettings;
}

export interface CreateInstanceDialogProps {
  open: boolean;
  onClose: () => void;
  nodes: ProxmoxNode[];
  versions: string[];
  /** Existing instances used to prevent duplicate names cluster-wide. */
  existingInstances?: DHIS2Instance[];
  /**
   * Called with the fully-prepared create-instance payload when the user
   * clicks "Create Instance". The dialog closes itself and resets its
   * internal form after invoking this callback.
   */
  onSubmit: (payload: CreateInstanceSubmitPayload) => void;
}

// DHIS2 2.40/2.41 ship a javax-namespace WAR (needs Tomcat 9); v42+ moved to
// jakarta and needs Tomcat 10. Accepts "2.41.8.1", "41.2.0", "41", "42".
const deriveTomcatFromDhis2 = (version: string): '9' | '10' | undefined => {
  const m = version.trim().match(/^(?:2\.)?(\d+)/);
  if (!m) return undefined;
  const major = Number(m[1]);
  if (!Number.isFinite(major)) return undefined;
  return major <= 41 ? '9' : '10';
};

const JAVA_HEAP_OPTIONS = ['2G', '4G', '8G', '12G', '16G', '24G', '32G', '64G'];

const normalizeJavaHeap = (value?: string): string => {
  const normalized = (value ?? '').trim().toUpperCase();
  return normalized || '4G';
};

const buildInitialInstance = (
  proxy: ProxyServerSettings,
): CreateInstanceRequest => ({
  name: '',
  domain: '',
  version: '',
  tomcatVersion: '9',
  node: '',
  resources: {
    cpu: 4,
    memory: 16384,
    storage: 40,
  },
  database: {
    name: '',
    user: 'dhis2',
    password: '',
  },
  rootPassword: '',
  proxyOverride: {
    mode: proxy.mode,
    baseDomain: proxy.baseDomain,
  },
});

export const CreateInstanceDialog = ({
  open,
  onClose,
  nodes,
  versions,
  existingInstances = [],
  onSubmit,
}: CreateInstanceDialogProps) => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const discoveryApi = useApi(discoveryApiRef);

  const [proxySettings, setProxySettings] = useState<ProxyServerSettings>(
    () => settingsService.load().proxy,
  );
  const [dhis2Settings, setDhis2Settings] = useState<DHIS2DefaultsSettings>(
    () => {
      const loaded = settingsService.load().dhis2;
      return {
        ...loaded,
        javaHeap: normalizeJavaHeap(loaded.javaHeap),
      };
    },
  );

  const [newInstance, setNewInstance] = useState<CreateInstanceRequest>(() =>
    buildInitialInstance(settingsService.load().proxy),
  );

  // Restore-from-backup state.
  const [restoreEnabled, setRestoreEnabled] = useState(false);
  const [restoreSource, setRestoreSource] = useState<RestoreSource | undefined>(
    undefined,
  );

  // "Create new database account" option.
  const [createDbAccount, setCreateDbAccount] = useState(false);
  const [showDbPassword, setShowDbPassword] = useState(false);
  const [showAdminDbPassword, setShowAdminDbPassword] = useState(false);
  // Credentials of the per-instance PostgreSQL role that will be created
  // when "Create a new database account" is ticked. Kept separate from the
  // "existing database" role credentials (newInstance.database.user/password)
  // so each section can carry its own values.
  const [newDbUser, setNewDbUser] = useState('');
  const [newDbPassword, setNewDbPassword] = useState('');
  const [showNewDbPassword, setShowNewDbPassword] = useState(false);

  // "Connect to an existing database" option.
  const [useExistingDb, setUseExistingDb] = useState(false);
  // "Use a remote PostgreSQL server" master toggle. Default is OFF, in
  // which case the orchestrator installs PostgreSQL inside the new LXC
  // and the remote-host / shared-credentials / existing-database fields
  // are hidden. The backend auto-generates a strong password for the
  // freshly created local role.
  const [useRemoteDb, setUseRemoteDb] = useState(false);
  const [availableDatabases, setAvailableDatabases] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [databasesError, setDatabasesError] = useState<string | null>(null);
  const [dbTestResult, setDbTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);
  const [checkingCompatibility, setCheckingCompatibility] = useState(false);
  const [existingDbCompatibility, setExistingDbCompatibility] = useState<{
    ok: boolean;
    compatible: boolean;
    message: string;
    checkedDatabase: string;
  } | null>(null);

  // "Customize dhis.conf template" option.
  const [customizeDhisConf, setCustomizeDhisConf] = useState(false);
  const [dhisConfTemplate, setDhisConfTemplate] = useState(
    DEFAULT_DHIS_CONF_TEMPLATE,
  );

  // "Delete existing instance with the same VMID first" option. Off by
  // default — enabling it triggers a confirmation prompt on submit since
  // the action is destructive (the existing LXC + DB are wiped).
  const [deleteIfExists, setDeleteIfExists] = useState(false);
  // Companion option: also stop + purge any LXC whose hostname matches
  // the new instance name, regardless of VMID. Useful when re-running a
  // provision that previously landed on a different VMID under the same
  // logical name. Gated behind the same confirmation prompt.
  const [deleteIfNameExists, setDeleteIfNameExists] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmDeleteVmid, setConfirmDeleteVmid] = useState<number | null>(
    null,
  );
  const [loadingConfirmDeleteVmid, setLoadingConfirmDeleteVmid] =
    useState(false);
  const [confirmDeleteVmidError, setConfirmDeleteVmidError] = useState<
    string | null
  >(null);

  // Tracks whether the operator has hand-picked a Tomcat major. When
  // false, picking a new DHIS2 version auto-aligns Tomcat (9 for 2.40/41,
  // 10 for v42+) so an incompatible pair can't slip through.
  const [tomcatUserOverride, setTomcatUserOverride] = useState(false);

  // Initialise default node/version from props when they arrive.
  useEffect(() => {
    if (nodes.length > 0 && !newInstance.node) {
      setNewInstance(prev => ({ ...prev, node: nodes[0].node }));
    }
  }, [nodes, newInstance.node]);

  useEffect(() => {
    if (versions.length > 0 && !newInstance.version) {
      const v = versions[0];
      setNewInstance(prev => ({
        ...prev,
        version: v,
        tomcatVersion: tomcatUserOverride
          ? prev.tomcatVersion
          : deriveTomcatFromDhis2(v) ?? prev.tomcatVersion,
      }));
    }
  }, [versions, newInstance.version, tomcatUserOverride]);

  const fetchExistingDatabases = async () => {
    setLoadingDatabases(true);
    setDatabasesError(null);
    setDbTestResult(null);
    setExistingDbCompatibility(null);

    // Validate inputs before hitting the backend so users see clear,
    // actionable errors in the dialog instead of a vague network failure.
    // "Test connection" authenticates as the PostgreSQL ADMIN role — that
    // is the identity the provisioner will use to create per-instance
    // roles/databases (or, in the existing-DB sub-case, to enumerate
    // candidate databases). The per-instance role username/password
    // intentionally are NOT tested here because they may not exist yet.
    const missing: string[] = [];
    if (!dhis2Settings.postgresHost) missing.push('Postgres host');
    if (!dhis2Settings.postgresPort) missing.push('Postgres port');
    if (!dhis2Settings.postgresAdminUser) missing.push('PostgreSQL admin user');
    if (!dhis2Settings.postgresAdminPassword)
      missing.push('PostgreSQL admin password');
    if (missing.length > 0) {
      const message = `Provide ${missing.join(', ')} before testing the connection.`;
      setDatabasesError(message);
      setDbTestResult({ ok: false, message });
      setAvailableDatabases([]);
      setLoadingDatabases(false);
      return;
    }

    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const creds = {
        host: dhis2Settings.postgresHost,
        port: dhis2Settings.postgresPort,
        user: dhis2Settings.postgresAdminUser,
        password: dhis2Settings.postgresAdminPassword,
      };
      const test = await dhis2Service.testDatabaseConnection(
        creds,
        baseUrl,
        backstageFetch,
      );
      if (!test.ok) {
        setAvailableDatabases([]);
        setDatabasesError(test.message);
        setDbTestResult({ ok: false, message: test.message });
        return;
      }
      const data = await dhis2Service.listDatabases(
        creds,
        baseUrl,
        backstageFetch,
      );
      setAvailableDatabases(data);
      setDbTestResult({
        ok: true,
        message: `Connected to ${creds.host}:${creds.port}${
          test.serverVersion ? ` (${test.serverVersion})` : ''
        } — ${data.length} database(s) found.`,
      });
    } catch (error) {
      console.error('Failed to list databases:', error);
      setAvailableDatabases([]);
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to list databases on the provided server.';
      setDatabasesError(message);
      setDbTestResult({ ok: false, message });
    } finally {
      setLoadingDatabases(false);
    }
  };

  const checkExistingDatabaseCompatibility = async (
    databaseName: string,
    targetVersionOverride?: string,
  ) => {
    const selectedDb = databaseName.trim();
    if (!selectedDb) {
      setExistingDbCompatibility(null);
      return;
    }

    const missing: string[] = [];
    if (!dhis2Settings.postgresHost) missing.push('Postgres host');
    if (!dhis2Settings.postgresPort) missing.push('Postgres port');
    if (!dhis2Settings.postgresAdminUser) missing.push('PostgreSQL admin user');
    if (!dhis2Settings.postgresAdminPassword)
      missing.push('PostgreSQL admin password');
    const targetVersion = targetVersionOverride ?? newInstance.version;
    if (!targetVersion) missing.push('DHIS2 version');
    if (missing.length > 0) {
      setExistingDbCompatibility({
        ok: false,
        compatible: false,
        message: `Provide ${missing.join(', ')} before checking compatibility.`,
        checkedDatabase: selectedDb,
      });
      return;
    }

    setCheckingCompatibility(true);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const result = await dhis2Service.checkExistingDatabaseCompatibility(
        {
          host: dhis2Settings.postgresHost,
          port: dhis2Settings.postgresPort,
          user: dhis2Settings.postgresAdminUser,
          password: dhis2Settings.postgresAdminPassword,
          database: selectedDb,
          targetVersion,
        },
        baseUrl,
        backstageFetch,
      );
      setExistingDbCompatibility({
        ok: result.ok,
        compatible: result.compatible,
        message: result.message,
        checkedDatabase: selectedDb,
      });
    } catch (error) {
      setExistingDbCompatibility({
        ok: false,
        compatible: false,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to check existing database compatibility.',
        checkedDatabase: selectedDb,
      });
    } finally {
      setCheckingCompatibility(false);
    }
  };

  const restoreValidationError = restoreEnabled
    ? validateRestoreSource(restoreSource) ??
      (restoreSource ? null : 'Pick a backup source.')
    : null;

  // Block submission early for fields the backend strictly requires, so the
  // user gets a precise inline message instead of a generic round-trip error
  // like '"name" is required'.
  const formValidationError: string | null = (() => {
    if (!newInstance.name.trim()) return 'Instance name is required.';
    const nameConflict = existingInstances.find(
      i => i.name.trim().toLowerCase() === newInstance.name.trim().toLowerCase(),
    );
    if (nameConflict) {
      return `An instance named "${nameConflict.name}" already exists on node ${nameConflict.node}. Choose a different name.`;
    }
    if (!newInstance.version) return 'DHIS2 version is required.';
    if (!newInstance.node) return 'Proxmox node is required.';
    if (useRemoteDb) {
      if (!dhis2Settings.postgresHost.trim())
        return 'Shared Postgres host is required when using a remote PostgreSQL server.';
      if (!dhis2Settings.postgresAdminUser.trim())
        return 'PostgreSQL admin user is required when using a remote PostgreSQL server.';
      if (!dhis2Settings.postgresAdminPassword)
        return 'PostgreSQL admin password is required when using a remote PostgreSQL server.';
    }
    if (useExistingDb && !useRemoteDb) {
      // For a remote PostgreSQL server we allow the DHIS2 role to be left
      // blank and fall back to the admin credentials at runtime. For the
      // local (in-LXC) flow no such fallback exists, so the role pair is
      // still required here.
      if (!newInstance.database.user.trim())
        return 'DHIS2 role username is required.';
      if (!newInstance.database.password)
        return 'DHIS2 role password is required.';
    }
    if (useExistingDb && !newInstance.database.name.trim()) {
      return 'Select an existing database.';
    }
    if (useExistingDb && checkingCompatibility) {
      return 'Checking selected database compatibility...';
    }
    if (
      useExistingDb &&
      newInstance.database.name.trim() &&
      (!existingDbCompatibility ||
        existingDbCompatibility.checkedDatabase !==
          newInstance.database.name.trim())
    ) {
      return 'Select a database and wait for compatibility check to complete.';
    }
    if (
      useExistingDb &&
      newInstance.database.name.trim() &&
      existingDbCompatibility &&
      (!existingDbCompatibility.ok || !existingDbCompatibility.compatible)
    ) {
      return existingDbCompatibility.message;
    }
    if (createDbAccount) {
      if (!newDbUser.trim())
        return 'New database account username is required.';
      if (!newDbPassword)
        return 'New database account password is required.';
    }
    return null;
  })();

  const handleCancel = () => {
    onClose();
  };

  const submitNow = () => {
    setConfirmDeleteOpen(false);
    doSubmit();
  };

  const handleSubmit = () => {
    if (deleteIfExists || deleteIfNameExists) {
      setConfirmDeleteOpen(true);
      setConfirmDeleteVmid(null);
      setConfirmDeleteVmidError(null);
      setLoadingConfirmDeleteVmid(true);
      const settings = settingsService.load();
      const pm = settings.proxmox;
      const apiUrl = (pm.apiUrl ?? '').trim();
      const tokenId = (pm.tokenId ?? '').trim();
      const tokenSecret = (pm.tokenSecret ?? '').trim();
      const username = (pm.username ?? '').trim();
      const proxmoxOverrides: {
        apiUrl?: string;
        apiUser?: string;
        apiTokenId?: string;
        apiTokenSecret?: string;
        validateApiCerts?: boolean;
      } = {};
      if (apiUrl) proxmoxOverrides.apiUrl = apiUrl;
      if (pm.authMethod === 'token') {
        if (tokenId) proxmoxOverrides.apiTokenId = tokenId;
        if (tokenSecret) proxmoxOverrides.apiTokenSecret = tokenSecret;
        if (!tokenId.includes('!') && username) {
          proxmoxOverrides.apiUser = username;
        }
      }
      proxmoxOverrides.validateApiCerts = Boolean(pm.verifyTls);
      const effectiveOverrides =
        Object.keys(proxmoxOverrides).length > 0 ? proxmoxOverrides : undefined;
      discoveryApi
        .getBaseUrl('dhis2')
        .then(baseUrl =>
          dhis2Service.getNextVmid(baseUrl, effectiveOverrides, backstageFetch),
        )
        .then(vmid => setConfirmDeleteVmid(vmid))
        .catch(error => {
          setConfirmDeleteVmidError(
            error instanceof Error
              ? error.message
              : 'Failed to fetch next VMID.',
          );
        })
        .finally(() => setLoadingConfirmDeleteVmid(false));
      return;
    }
    doSubmit();
  };

  const doSubmit = () => {
    const derivedDomain =
      proxySettings.mode === 'subdomain'
        ? `${newInstance.name}.${proxySettings.baseDomain}`
        : `${proxySettings.baseDomain}/${newInstance.name}`;
    // Default the database name to the instance name when the user has
    // not provided one explicitly (the Name field's onChange keeps the
    // two in sync while typing, but this guards against the field being
    // cleared, or against an existing-database flow where the operator
    // forgot to pick one).
    const dbName =
      newInstance.database.name && newInstance.database.name.trim() !== ''
        ? newInstance.database.name
        : newInstance.name;
    // When connecting to an existing database on a remote PostgreSQL server,
    // allow the DHIS2 role credentials to fall back to the admin user. This
    // lets operators wire up DHIS2 against a pre-existing database without
    // first creating a dedicated role.
    const effectiveDbUser =
      useExistingDb && useRemoteDb && !newInstance.database.user.trim()
        ? dhis2Settings.postgresAdminUser
        : newInstance.database.user;
    const effectiveDbPassword =
      useExistingDb && useRemoteDb && !newInstance.database.password
        ? dhis2Settings.postgresAdminPassword
        : newInstance.database.password;
    // When the operator has not enabled the "remote PostgreSQL server"
    // toggle, the orchestrator installs PostgreSQL inside the new LXC.
    // Clear any inherited shared-host defaults so the backend doesn't
    // accidentally route the new instance at a previously-configured
    // external host.
    const effectiveDhis2Settings = useRemoteDb
      ? dhis2Settings
      : { ...dhis2Settings, postgresHost: '' };
    const request: CreateInstanceRequest = {
      ...newInstance,
      domain: derivedDomain,
      database: {
        ...newInstance.database,
        name: dbName,
        user: effectiveDbUser,
        password: effectiveDbPassword,
        existing: useExistingDb ? true : undefined,
        host:
          useRemoteDb && useExistingDb ? dhis2Settings.postgresHost : undefined,
        port:
          useRemoteDb && useExistingDb ? dhis2Settings.postgresPort : undefined,
      },
      restore: restoreEnabled ? restoreSource : undefined,
      // "Create a new database account" provisions an additional DHIS2 role
      // on the shared host using the credentials above and grants it
      // ownership of the database.
      newDbAccount: createDbAccount
        ? {
            user: newDbUser,
            password: newDbPassword,
          }
        : undefined,
      dhisConfTemplate:
        customizeDhisConf && dhisConfTemplate !== DEFAULT_DHIS_CONF_TEMPLATE
          ? dhisConfTemplate
          : undefined,
      deleteIfExists: deleteIfExists || undefined,
      deleteIfNameExists: deleteIfNameExists || undefined,
      proxySettings,
      dhis2Settings: effectiveDhis2Settings,
    };
    // Intentionally do NOT close/reset the dialog here. The parent stacks
    // the provisioning-progress dialog on top of this one so the form
    // values stay intact — if the job fails, the user can adjust a field
    // and click "Create Instance" again without re-entering everything.
    onSubmit({
      request,
      derivedDomain,
      proxySettings,
      dhis2Settings: effectiveDhis2Settings,
    });
  };

  return (
    <>
    <Dialog open={open} onClose={handleCancel} maxWidth="md" fullWidth>
      <DialogTitle>Create New DHIS2 Instance</DialogTitle>
      <DialogContent>
        <Typography variant="h6" gutterBottom>
          Instance Configurations
        </Typography>
        <TextField
          fullWidth
          label="Instance Name"
          value={newInstance.name}
          onChange={e => {
            const newName = e.target.value;
            setNewInstance(prev => {
              const dbNameInSync =
                !prev.database.name || prev.database.name === prev.name;
              // Keep the existing-DB role username in sync with the instance
              // name while the operator hasn't customised it (defaults to
              // 'dhis2' when the name is empty).
              const dbUserInSync =
                !prev.database.user ||
                prev.database.user === prev.name ||
                prev.database.user === 'dhis2';
              return {
                ...prev,
                name: newName,
                database: {
                  ...prev.database,
                  name: dbNameInSync ? newName : prev.database.name,
                  user: dbUserInSync
                    ? newName || 'dhis2'
                    : prev.database.user,
                },
              };
            });
            // Same auto-sync for the new-account username.
            setNewDbUser(prev =>
              !prev || prev === newInstance.name || prev === 'dhis2'
                ? newName || 'dhis2'
                : prev,
            );
          }}
          className={classes.formField}
          helperText="Used as the proxy path segment and as the default database name"
          required
        />
        <Grid container spacing={2}>
          <Grid item xs={4}>
            <TextField
              fullWidth
              select
              label="DHIS2 Version"
              value={newInstance.version}
              onChange={e => {
                const v = e.target.value;
                setNewInstance(prev => ({
                  ...prev,
                  version: v,
                  tomcatVersion: tomcatUserOverride
                    ? prev.tomcatVersion
                    : deriveTomcatFromDhis2(v) ?? prev.tomcatVersion,
                }));
                if (useExistingDb && newInstance.database.name.trim()) {
                  setExistingDbCompatibility(null);
                  checkExistingDatabaseCompatibility(
                    newInstance.database.name,
                    v,
                  );
                }
              }}
              className={classes.formField}
              required
            >
              {versions.map(version => (
                <MenuItem key={version} value={version}>
                  {version}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={4}>
            <TextField
              fullWidth
              select
              label="Tomcat Version"
              value={newInstance.tomcatVersion ?? '9'}
              onChange={e => {
                setTomcatUserOverride(true);
                setNewInstance({
                  ...newInstance,
                  tomcatVersion: e.target.value as '9' | '10',
                });
              }}
              className={classes.formField}
              helperText="Auto-selected from DHIS2 version (2.40/2.41 → 9 javax, v42+ → 10 jakarta). Override only if you know why."
              required
            >
              <MenuItem value="9">9</MenuItem>
              <MenuItem value="10">10</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={4}>
            <TextField
              fullWidth
              select
              label="Proxmox Node"
              value={newInstance.node}
              onChange={e =>
                setNewInstance({ ...newInstance, node: e.target.value })
              }
              className={classes.formField}
              required
            >
              {nodes.map(n => (
                <MenuItem key={n.node} value={n.node}>
                  {n.node}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
        </Grid>
        <FormControlLabel
          control={
            <Checkbox
              checked={deleteIfExists}
              onChange={e => setDeleteIfExists(e.target.checked)}
              color="secondary"
            />
          }
          label={
            <Box>
              <Typography variant="body2">
                Delete existing instance with the same VMID first
              </Typography>
              <Typography variant="caption" color="textSecondary">
                Destructive — stops and removes the existing LXC container
                (and its database) before provisioning the new one. Useful
                when re-running a failed install.
              </Typography>
            </Box>
          }
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={deleteIfNameExists}
              onChange={e => setDeleteIfNameExists(e.target.checked)}
              color="secondary"
            />
          }
          label={
            <Box>
              <Typography variant="body2">
                Delete existing instance with the same Name first
              </Typography>
              <Typography variant="caption" color="textSecondary">
                Destructive — scans the Proxmox cluster for any LXC whose
                hostname matches this instance name (regardless of VMID)
                and purges each match before provisioning.
              </Typography>
            </Box>
          }
        />
        <Typography variant="h6" gutterBottom style={{ marginTop: 16 }}>
          Resources
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={4}>
            <TextField
              fullWidth
              type="number"
              label="CPU Cores"
              value={newInstance.resources.cpu}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  resources: {
                    ...newInstance.resources,
                    cpu: e.target.value === '' ? ('' as any) : parseInt(e.target.value, 10),
                  },
                })
              }
              className={classes.formField}
              inputProps={{ min: 1, max: 16 }}
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              fullWidth
              select
              label="Memory (MB)"
              value={newInstance.resources.memory}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  resources: {
                    ...newInstance.resources,
                    memory: parseInt(e.target.value, 10),
                  },
                })
              }
              className={classes.formField}
            >
              <MenuItem value={4096}>4096 MB</MenuItem>
              <MenuItem value={8192}>8192 MB</MenuItem>
              <MenuItem value={16384}>16384 MB</MenuItem>
              <MenuItem value={32768}>32768 MB</MenuItem>
              <MenuItem value={65536}>65536 MB</MenuItem>
              <MenuItem value={131072}>131072 MB</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={4}>
            <TextField
              fullWidth
              select
              label="Storage (GB)"
              value={newInstance.resources.storage}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  resources: {
                    ...newInstance.resources,
                    storage: parseInt(e.target.value, 10),
                  },
                })
              }
              className={classes.formField}
            >
              <MenuItem value={20}>20GB</MenuItem>
              <MenuItem value={40}>40GB</MenuItem>
              <MenuItem value={60}>60GB</MenuItem>
              <MenuItem value={80}>80GB</MenuItem>
              <MenuItem value={100}>100GB</MenuItem>
              <MenuItem value={120}>120GB</MenuItem>
              <MenuItem value={140}>140GB</MenuItem>
              <MenuItem value={160}>160GB</MenuItem>
            </TextField>
          </Grid>
        </Grid>
        <Grid container spacing={2}>
          <Grid item xs={6}>
            <TextField
              fullWidth
              select
              label="Java heap (Xmx)"
              value={dhis2Settings.javaHeap}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  javaHeap: normalizeJavaHeap(e.target.value),
                })
              }
              className={classes.formField}
              helperText="Maximum JVM heap size for DHIS2"
            >
              {!JAVA_HEAP_OPTIONS.includes(dhis2Settings.javaHeap) &&
                dhis2Settings.javaHeap && (
                  <MenuItem value={dhis2Settings.javaHeap}>
                    {dhis2Settings.javaHeap}
                  </MenuItem>
                )}
              {JAVA_HEAP_OPTIONS.map(heap => (
                <MenuItem key={heap} value={heap}>
                  {heap}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={6}>
            <TextField
              fullWidth
              type="number"
              label="Tomcat port"
              value={dhis2Settings.tomcatPort}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  tomcatPort: parseInt(e.target.value, 10) || 8080,
                })
              }
              className={classes.formField}
            />
          </Grid>
        </Grid>
        <TextField
          fullWidth
          type="password"
          label="LXC Root Password"
          value={newInstance.rootPassword ?? ''}
          onChange={e =>
            setNewInstance({ ...newInstance, rootPassword: e.target.value })
          }
          className={classes.formField}
          helperText="Optional. Root password for the LXC container's default root user. Leave blank to have a strong password auto-generated and shown once in the provisioning log."
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={customizeDhisConf}
              onChange={e => {
                const next = e.target.checked;
                setCustomizeDhisConf(next);
                if (next && !dhisConfTemplate) {
                  setDhisConfTemplate(DEFAULT_DHIS_CONF_TEMPLATE);
                }
              }}
              color="primary"
            />
          }
          label="Customize dhis.conf template"
        />
        <Typography
          variant="caption"
          color="textSecondary"
          component="div"
          style={{ marginBottom: 8 }}
        >
          Tick to override the bundled <code>dhis.conf</code> Jinja template.
          Placeholders such as <code>{'{{ dhis2_db_host }}'}</code> remain
          rendered by the Ansible role at provisioning time.
        </Typography>
        {customizeDhisConf && (
          <>
            <Box
              display="flex"
              justifyContent="flex-end"
              alignItems="center"
              style={{ marginBottom: 4 }}
            >
              <Tooltip title="Reset to default template">
                <IconButton
                  size="small"
                  onClick={() => setDhisConfTemplate(DEFAULT_DHIS_CONF_TEMPLATE)}
                >
                  <SettingsBackupRestoreIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Copy template to clipboard">
                <IconButton
                  size="small"
                  onClick={() => {
                    if (dhisConfTemplate) {
                      navigator.clipboard
                        ?.writeText(dhisConfTemplate)
                        .catch(() => {});
                    }
                  }}
                >
                  <FileCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              fullWidth
              multiline
              rows={20}
              label="dhis.conf template"
              value={dhisConfTemplate}
              onChange={e => setDhisConfTemplate(e.target.value)}
              className={classes.formField}
              variant="outlined"
              InputProps={{
                style: {
                  fontFamily:
                    'Menlo, Consolas, "Liberation Mono", monospace',
                  fontSize: '0.8rem',
                },
              }}
              helperText="Jinja syntax is rendered at provisioning time. Use the reset icon to restore the default."
            />
          </>
        )}
        <Typography variant="h6" gutterBottom style={{ marginTop: 16 }}>
          Database Configurations
        </Typography>
        <FormControlLabel
          control={
            <Checkbox
              checked={useRemoteDb}
              onChange={e => {
                const next = e.target.checked;
                setUseRemoteDb(next);
                if (!next) {
                  // Collapse all remote-only sub-state so re-opening the
                  // toggle later starts from a clean slate.
                  setUseExistingDb(false);
                  setCreateDbAccount(false);
                  setAvailableDatabases([]);
                  setDatabasesError(null);
                  setDbTestResult(null);
                  setExistingDbCompatibility(null);
                }
              }}
              color="primary"
            />
          }
          label={
            <Box>
              <Typography variant="body2">
                Use a remote PostgreSQL server
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {useRemoteDb
                  ? 'DHIS2 will connect to the external PostgreSQL host configured below.'
                  : 'Off — PostgreSQL is installed inside the new LXC container and a strong database password is auto-generated.'}
              </Typography>
            </Box>
          }
        />
        {useRemoteDb && (
          <>
        <Typography
          variant="body2"
          color="textSecondary"
          style={{ marginBottom: 8 }}
        >
          DHIS2 will connect to the PostgreSQL server below using the admin
          credentials.
        </Typography>
        <Grid container spacing={2} style={{ marginTop: 16 }}>
          <Grid item xs={12} sm={8} md={6}>
            <TextField
              fullWidth
              label="Shared Postgres host"
              value={dhis2Settings.postgresHost}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  postgresHost: e.target.value,
                })
              }
              className={classes.formField}
              required
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <TextField
              fullWidth
              type="number"
              label="Port"
              value={dhis2Settings.postgresPort}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  postgresPort: parseInt(e.target.value, 10) || 5432,
                })
              }
              className={classes.formField}
            />
          </Grid>
          <Grid item xs={6} sm={6} md={4}>
            <TextField
              fullWidth
              label="PostgreSQL admin user"
              value={dhis2Settings.postgresAdminUser}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  postgresAdminUser: e.target.value,
                })
              }
              className={classes.formField}
              required
              helperText="Existing PostgreSQL role used to create/inspect databases on the shared host (commonly 'postgres')."
            />
          </Grid>
          <Grid item xs={12} sm={6} md={6}>
            <TextField
              fullWidth
              type={showAdminDbPassword ? 'text' : 'password'}
              label="PostgreSQL admin password"
              value={dhis2Settings.postgresAdminPassword}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  postgresAdminPassword: e.target.value,
                })
              }
              className={classes.formField}
              required
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip
                      title={
                        showAdminDbPassword ? 'Hide password' : 'Show password'
                      }
                    >
                      <IconButton
                        size="small"
                        onClick={() => setShowAdminDbPassword(s => !s)}
                      >
                        {showAdminDbPassword ? (
                          <VisibilityOffIcon fontSize="small" />
                        ) : (
                          <VisibilityIcon fontSize="small" />
                        )}
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              }}
            />
          </Grid>
        </Grid>
          </>
        )}
        <Box
          mt={1}
          mb={1}
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={useExistingDb}
                onChange={e => {
                  const next = e.target.checked;
                  setUseExistingDb(next);
                  if (next) {
                    // Seed the existing-DB role username with a sensible
                    // default if the field is empty.
                    setNewInstance(prev =>
                      prev.database.user
                        ? prev
                        : {
                            ...prev,
                            database: {
                              ...prev.database,
                              user: prev.name || 'dhis2',
                            },
                          },
                    );
                    setExistingDbCompatibility(null);
                  } else {
                    setAvailableDatabases([]);
                    setDatabasesError(null);
                    setDbTestResult(null);
                    setExistingDbCompatibility(null);
                  }
                }}
                color="primary"
              />
            }
            label="Connect to an existing database"
          />
          <Button
            variant="outlined"
            size="small"
            onClick={() => fetchExistingDatabases()}
            disabled={!useExistingDb || loadingDatabases}
            startIcon={
              loadingDatabases ? <CircularProgress size={16} /> : undefined
            }
          >
            Test connection
          </Button>
        </Box>
        {dbTestResult && (
          <Alert
            severity={dbTestResult.ok ? 'success' : 'error'}
            onClose={() => setDbTestResult(null)}
            style={{ marginTop: 8, marginBottom: 8 }}
          >
            {dbTestResult.message}
          </Alert>
        )}
        {useExistingDb && checkingCompatibility && (
          <Alert severity="info" style={{ marginTop: 8, marginBottom: 8 }}>
            Checking selected database compatibility...
          </Alert>
        )}
        {useExistingDb && existingDbCompatibility && !checkingCompatibility && (
          <Alert
            severity={
              existingDbCompatibility.ok && existingDbCompatibility.compatible
                ? 'success'
                : 'error'
            }
            style={{ marginTop: 8, marginBottom: 8 }}
          >
            {existingDbCompatibility.message}
          </Alert>
        )}
        {!useExistingDb && (
          <TextField
            fullWidth
            label="Database Name"
            value={newInstance.database.name}
            onChange={e =>
              setNewInstance({
                ...newInstance,
                database: {
                  ...newInstance.database,
                  name: e.target.value,
                },
              })
            }
            placeholder={newInstance.name || 'defaults to instance name'}
            helperText={
              newInstance.database.name
                ? undefined
                : `Defaults to the instance name${
                    newInstance.name ? ` ("${newInstance.name}")` : ''
                  }.`
            }
            className={classes.formField}
            InputLabelProps={{ shrink: true }}
          />
        )}
        {useExistingDb && (
          <Alert severity="warning" style={{ marginTop: 8, marginBottom: 8 }}>
            Existing database mode assumes the selected database is compatible
            with the chosen DHIS2 version and has a supported upgrade path.
            Incompatible schema state can fail during Flyway migrations at
            startup.
          </Alert>
        )}
        {useExistingDb && (
          <Grid container spacing={2}>
            <Grid item xs={6} sm={6} md={4}>
              <TextField
                fullWidth
                label="DHIS2 role username"
                value={newInstance.database.user}
                onChange={e =>
                  setNewInstance({
                    ...newInstance,
                    database: {
                      ...newInstance.database,
                      user: e.target.value,
                    },
                  })
                }
                className={classes.formField}
                required={!useRemoteDb}
                placeholder={
                  useRemoteDb
                    ? dhis2Settings.postgresAdminUser ||
                      'falls back to admin user'
                    : undefined
                }
                InputLabelProps={useRemoteDb ? { shrink: true } : undefined}
                helperText={
                  useRemoteDb
                    ? `PostgreSQL role DHIS2 will authenticate as at runtime. Leave blank to fall back to the admin user (${dhis2Settings.postgresAdminUser || 'postgres'}).`
                    : 'PostgreSQL role DHIS2 will authenticate as at runtime (must already exist unless you tick "Create a new database account" below).'
                }
              />
            </Grid>
            <Grid item xs={12} sm={6} md={6}>
              <TextField
                fullWidth
                type={showDbPassword ? 'text' : 'password'}
                label="DHIS2 role password"
                value={newInstance.database.password}
                onChange={e =>
                  setNewInstance({
                    ...newInstance,
                    database: {
                      ...newInstance.database,
                      password: e.target.value,
                    },
                  })
                }
                className={classes.formField}
                required={!useRemoteDb}
                placeholder={
                  useRemoteDb ? 'falls back to admin password' : undefined
                }
                InputLabelProps={useRemoteDb ? { shrink: true } : undefined}
                helperText={
                  useRemoteDb
                    ? 'Leave blank to fall back to the admin password.'
                    : undefined
                }
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip
                        title={
                          showDbPassword ? 'Hide password' : 'Show password'
                        }
                      >
                        <IconButton
                          size="small"
                          onClick={() => setShowDbPassword(s => !s)}
                        >
                          {showDbPassword ? (
                            <VisibilityOffIcon fontSize="small" />
                          ) : (
                            <VisibilityIcon fontSize="small" />
                          )}
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>
          </Grid>
        )}
        {useExistingDb && (
          <FormControl
            fullWidth
            className={classes.formField}
            required
            error={Boolean(databasesError)}
          >
            <InputLabel>Database</InputLabel>
            <Select
              value={newInstance.database.name}
              onChange={e => {
                const selected = e.target.value as string;
                setNewInstance({
                  ...newInstance,
                  database: {
                    ...newInstance.database,
                    name: selected,
                  },
                });
                // Re-run compatibility checks for the newly selected DB.
                setExistingDbCompatibility(null);
                checkExistingDatabaseCompatibility(selected);
              }}
              endAdornment={
                <InputAdornment position="end" style={{ marginRight: 24 }}>
                  <Tooltip title="Refresh database list">
                    <span>
                      <IconButton
                        size="small"
                        disabled={loadingDatabases}
                        onClick={() => fetchExistingDatabases()}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </InputAdornment>
              }
            >
              {availableDatabases.length === 0 && (
                <MenuItem value="" disabled>
                  {loadingDatabases
                    ? 'Loading databases…'
                    : 'Click "Test connection" to load databases'}
                </MenuItem>
              )}
              {availableDatabases.map(db => (
                <MenuItem key={db} value={db}>
                  {db}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>
              {databasesError
                ? databasesError
                : `Listed from ${dhis2Settings.postgresHost || '<host>'}:${dhis2Settings.postgresPort} as ${dhis2Settings.postgresAdminUser || '<admin>'}`}
            </FormHelperText>
          </FormControl>
        )}
        <FormControlLabel
          control={
            <Checkbox
              checked={createDbAccount}
              onChange={e => {
                const next = e.target.checked;
                setCreateDbAccount(next);
                if (next) {
                  // Seed sensible defaults: username from instance name
                  // (or 'dhis2') and a strong generated password.
                  setNewDbUser(prev => prev || newInstance.name || 'dhis2');
                  setNewDbPassword(
                    prev => prev || generateStrongPassword(),
                  );
                }
              }}
              color="primary"
            />
          }
          label="Create a new database account for this instance"
        />
        <Typography
          variant="caption"
          color="textSecondary"
          component="div"
          style={{ marginBottom: 8 }}
        >
          Tick to create a new PostgreSQL role in addition to using the
          credentials above. The new role will be granted ownership of the
          database.
        </Typography>
        {createDbAccount && (
          <Grid container spacing={2}>
            <Grid item xs={6} sm={6} md={4}>
              <TextField
                fullWidth
                label="New DHIS2 role username"
                value={newDbUser}
                onChange={e => setNewDbUser(e.target.value)}
                className={classes.formField}
                required
                helperText="PostgreSQL role to be created on the shared host and granted ownership of the database."
              />
            </Grid>
            <Grid item xs={12} sm={6} md={6}>
              <TextField
                fullWidth
                type={showNewDbPassword ? 'text' : 'password'}
                label="New DHIS2 role password"
                value={newDbPassword}
                onChange={e => setNewDbPassword(e.target.value)}
                className={classes.formField}
                required
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip
                        title={
                          showNewDbPassword ? 'Hide password' : 'Show password'
                        }
                      >
                        <IconButton
                          size="small"
                          onClick={() => setShowNewDbPassword(s => !s)}
                        >
                          {showNewDbPassword ? (
                            <VisibilityOffIcon fontSize="small" />
                          ) : (
                            <VisibilityIcon fontSize="small" />
                          )}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Generate strong password">
                        <IconButton
                          size="small"
                          onClick={() =>
                            setNewDbPassword(generateStrongPassword())
                          }
                        >
                          <VpnKeyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>
          </Grid>
        )}
        {!useExistingDb && (
          <>
            <Typography variant="h6" gutterBottom style={{ marginTop: 16 }}>
              Initial Data
            </Typography>
            <RadioGroup
              row
              value={restoreEnabled ? 'restore' : 'empty'}
              onChange={e => {
                const next = e.target.value === 'restore';
                setRestoreEnabled(next);
                if (!next) setRestoreSource(undefined);
              }}
            >
              <FormControlLabel
                value="empty"
                control={<Radio />}
                label="Empty database (DHIS2 initialises the schema)"
              />
              <FormControlLabel
                value="restore"
                control={<Radio />}
                label="Restore from an existing backup"
              />
            </RadioGroup>
            {restoreEnabled && (
              <Box mt={1} mb={2}>
                <RestoreSourcePicker
                  value={restoreSource}
                  onChange={setRestoreSource}
                  nodes={nodes}
                />
                {restoreValidationError && (
                  <Typography variant="caption" color="error">
                    {restoreValidationError}
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  color="textSecondary"
                  component="div"
                  style={{ marginTop: 8 }}
                >
                  Note: the restored database keeps its own DHIS2 admin user and
                  password.
                </Typography>
              </Box>
            )}
          </>
        )}
        <Divider style={{ margin: '16px 0' }} />
        <Typography variant="subtitle2" color="textSecondary" gutterBottom>
          Backups
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} md={3}>
            <FormControlLabel
              control={
                <Switch
                  checked={dhis2Settings.backupEnabled}
                  onChange={e =>
                    setDhis2Settings({
                      ...dhis2Settings,
                      backupEnabled: e.target.checked,
                    })
                  }
                />
              }
              label="Enable backups"
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              label="Schedule (cron)"
              value={dhis2Settings.backupSchedule}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  backupSchedule: e.target.value,
                })
              }
              disabled={!dhis2Settings.backupEnabled}
              className={classes.formField}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              type="number"
              label="Retention (days)"
              value={dhis2Settings.backupRetentionDays}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  backupRetentionDays: parseInt(e.target.value, 10) || 7,
                })
              }
              disabled={!dhis2Settings.backupEnabled}
              className={classes.formField}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              label="Offsite bucket (optional)"
              value={dhis2Settings.backupBucket ?? ''}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  backupBucket: e.target.value,
                })
              }
              disabled={!dhis2Settings.backupEnabled}
              helperText="s3://bucket/path"
              className={classes.formField}
            />
          </Grid>
        </Grid>
        <Typography variant="h6" gutterBottom style={{ marginTop: 16 }}>
          Reverse Proxy Configurations
        </Typography>
        <Typography
          variant="body2"
          color="textSecondary"
          style={{ marginBottom: 8 }}
        >
          Pre-filled from the saved plugin defaults. Adjust any value to
          override how this specific instance is exposed.
        </Typography>
        {(() => {
          const scheme = proxySettings.forceHttps ? 'https' : 'http';
          const examples =
            proxySettings.mode === 'subdomain'
              ? [
                  `${scheme}://${newInstance.name || 'hmis'}.${proxySettings.baseDomain}`,
                ]
              : [
                  `${scheme}://${proxySettings.baseDomain}/${newInstance.name || 'hmis'}`,
                ];
          return (
            <>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <FormControl fullWidth className={classes.formField}>
                    <InputLabel>Routing mode</InputLabel>
                    <Select
                      value={proxySettings.mode}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          mode: e.target.value as 'path' | 'subdomain',
                        })
                      }
                    >
                      <MenuItem value="path">
                        Path-based (base/instance)
                      </MenuItem>
                      <MenuItem value="subdomain">
                        Subdomain-based (instance.base)
                      </MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} md={8}>
                  <TextField
                    fullWidth
                    label="Base domain"
                    value={proxySettings.baseDomain}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        baseDomain: e.target.value,
                      })
                    }
                    helperText={
                      proxySettings.mode === 'path'
                        ? 'e.g. dhis2.example.org — path uses the instance name'
                        : 'e.g. example.org'
                    }
                    className={classes.formField}
                  />
                </Grid>
              </Grid>
              <Typography variant="caption" color="textSecondary">
                Example URLs:
              </Typography>
              <Box
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  marginTop: 4,
                  marginBottom: 16,
                }}
              >
                {examples.map(u => (
                  <div key={u}>{u}</div>
                ))}
              </Box>
              <Divider style={{ marginBottom: 16 }} />
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Proxy host"
                    value={proxySettings.host}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        host: e.target.value,
                      })
                    }
                    helperText="SSH-reachable hostname or IP of the proxy server"
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={6} md={2}>
                  <TextField
                    fullWidth
                    type="number"
                    label="SSH port"
                    value={proxySettings.sshPort}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        sshPort: parseInt(e.target.value, 10) || 22,
                      })
                    }
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={6} md={4}>
                  <TextField
                    fullWidth
                    label="SSH user"
                    value={proxySettings.sshUser}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        sshUser: e.target.value,
                      })
                    }
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <FormControl fullWidth className={classes.formField}>
                    <InputLabel>SSH auth</InputLabel>
                    <Select
                      value={proxySettings.authMethod}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          authMethod: e.target.value as 'ssh-key' | 'password',
                        })
                      }
                    >
                      <MenuItem value="ssh-key">SSH key</MenuItem>
                      <MenuItem value="password">Password</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                {proxySettings.authMethod === 'ssh-key' ? (
                  <Grid item xs={12} md={8}>
                    <TextField
                      fullWidth
                      label="SSH private key path"
                      value={proxySettings.sshKeyPath ?? ''}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          sshKeyPath: e.target.value,
                        })
                      }
                      helperText="Path on the Backstage backend host"
                      className={classes.formField}
                    />
                  </Grid>
                ) : (
                  <Grid item xs={12} md={8}>
                    <TextField
                      fullWidth
                      type="password"
                      label="SSH password"
                      value={proxySettings.sshPassword ?? ''}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          sshPassword: e.target.value,
                        })
                      }
                      className={classes.formField}
                    />
                  </Grid>
                )}
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Nginx config directory"
                    value={proxySettings.nginxConfigPath}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        nginxConfigPath: e.target.value,
                      })
                    }
                    helperText="e.g. /etc/nginx/upstream"
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Nginx reload command"
                    value={proxySettings.nginxReloadCommand}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        nginxReloadCommand: e.target.value,
                      })
                    }
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <FormControl fullWidth className={classes.formField}>
                    <InputLabel>SSL provider</InputLabel>
                    <Select
                      value={proxySettings.sslProvider}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          sslProvider: e.target.value as
                            | 'letsencrypt'
                            | 'manual'
                            | 'none',
                        })
                      }
                    >
                      <MenuItem value="letsencrypt">
                        Let's Encrypt (ACME)
                      </MenuItem>
                      <MenuItem value="manual">Manual certificate</MenuItem>
                      <MenuItem value="none">None (HTTP only)</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                {proxySettings.sslProvider === 'letsencrypt' && (
                  <Grid item xs={12} md={8}>
                    <TextField
                      fullWidth
                      label="Let's Encrypt email"
                      value={proxySettings.letsencryptEmail ?? ''}
                      onChange={e =>
                        setProxySettings({
                          ...proxySettings,
                          letsencryptEmail: e.target.value,
                        })
                      }
                      className={classes.formField}
                    />
                  </Grid>
                )}
                {proxySettings.sslProvider === 'manual' && (
                  <>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        label="SSL cert path"
                        value={proxySettings.sslCertPath ?? ''}
                        onChange={e =>
                          setProxySettings({
                            ...proxySettings,
                            sslCertPath: e.target.value,
                          })
                        }
                        className={classes.formField}
                      />
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        label="SSL key path"
                        value={proxySettings.sslKeyPath ?? ''}
                        onChange={e =>
                          setProxySettings({
                            ...proxySettings,
                            sslKeyPath: e.target.value,
                          })
                        }
                        className={classes.formField}
                      />
                    </Grid>
                  </>
                )}
                <Grid item xs={12} md={4}>
                  <TextField
                    fullWidth
                    type="number"
                    label="Upstream port"
                    value={proxySettings.upstreamPort}
                    onChange={e =>
                      setProxySettings({
                        ...proxySettings,
                        upstreamPort: parseInt(e.target.value, 10) || 8080,
                      })
                    }
                    helperText="Port DHIS2 listens on in the container"
                    className={classes.formField}
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={proxySettings.forceHttps}
                        onChange={e =>
                          setProxySettings({
                            ...proxySettings,
                            forceHttps: e.target.checked,
                          })
                        }
                      />
                    }
                    label="Force HTTPS"
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={proxySettings.enableHsts}
                        onChange={e =>
                          setProxySettings({
                            ...proxySettings,
                            enableHsts: e.target.checked,
                          })
                        }
                      />
                    }
                    label="Enable HSTS"
                  />
                </Grid>
              </Grid>
            </>
          );
        })()}
      </DialogContent>
      <DialogActions>
        {formValidationError && (
          <Alert
            severity="warning"
            style={{ marginRight: 'auto', padding: '0 12px' }}
          >
            {formValidationError}
          </Alert>
        )}
        <Button onClick={handleCancel}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          color="primary"
          variant="contained"
          disabled={
            Boolean(restoreValidationError) || Boolean(formValidationError)
          }
        >
          Create Instance
        </Button>
      </DialogActions>
    </Dialog>
    <Dialog
      open={confirmDeleteOpen}
      onClose={() => setConfirmDeleteOpen(false)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Delete existing instance?</DialogTitle>
      <DialogContent>
        <Alert severity="warning" style={{ marginBottom: 12 }}>
          This will permanently stop and remove the existing LXC container
          (and its DHIS2 database) before provisioning the new one. This
          action cannot be undone.
        </Alert>
        <Typography variant="body2">
          Proceed with deleting any existing instance at VMID{' '}
          <strong>
            {loadingConfirmDeleteVmid
              ? '...'
              : confirmDeleteVmid ?? 'next available'}
          </strong>{' '}
          and creating <strong>{newInstance.name || '(unnamed)'}</strong>?
        </Typography>
        {confirmDeleteVmidError && (
          <Typography variant="caption" color="error">
            {confirmDeleteVmidError}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirmDeleteOpen(false)}>Cancel</Button>
        <Button
          onClick={submitNow}
          color="secondary"
          variant="contained"
        >
          Delete & Create
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};
