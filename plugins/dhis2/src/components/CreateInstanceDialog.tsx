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
  ProxmoxNode,
  ProxyServerSettings,
  DHIS2DefaultsSettings,
  RestoreSource,
} from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { validateRestoreSource } from '../services/restoreService';
import { RestoreSourcePicker } from './RestoreSourcePicker';

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
  /**
   * Called with the fully-prepared create-instance payload when the user
   * clicks "Create Instance". The dialog closes itself and resets its
   * internal form after invoking this callback.
   */
  onSubmit: (payload: CreateInstanceSubmitPayload) => void;
}

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
    memory: 8192,
    storage: 100,
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
  onSubmit,
}: CreateInstanceDialogProps) => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const discoveryApi = useApi(discoveryApiRef);

  const [proxySettings, setProxySettings] = useState<ProxyServerSettings>(
    () => settingsService.load().proxy,
  );
  const [dhis2Settings, setDhis2Settings] = useState<DHIS2DefaultsSettings>(
    () => settingsService.load().dhis2,
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

  // "Customize dhis.conf template" option.
  const [customizeDhisConf, setCustomizeDhisConf] = useState(false);
  const [dhisConfTemplate, setDhisConfTemplate] = useState(
    DEFAULT_DHIS_CONF_TEMPLATE,
  );

  // "Delete existing instance with the same VMID first" option. Off by
  // default — enabling it triggers a confirmation prompt on submit since
  // the action is destructive (the existing LXC + DB are wiped).
  const [deleteIfExists, setDeleteIfExists] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Initialise default node/version from props when they arrive.
  useEffect(() => {
    if (nodes.length > 0 && !newInstance.node) {
      setNewInstance(prev => ({ ...prev, node: nodes[0].node }));
    }
  }, [nodes, newInstance.node]);

  useEffect(() => {
    if (versions.length > 0 && !newInstance.version) {
      setNewInstance(prev => ({ ...prev, version: versions[0] }));
    }
  }, [versions, newInstance.version]);

  const fetchExistingDatabases = async () => {
    setLoadingDatabases(true);
    setDatabasesError(null);
    setDbTestResult(null);

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

  const restoreValidationError = restoreEnabled
    ? validateRestoreSource(restoreSource) ??
      (restoreSource ? null : 'Pick a backup source.')
    : null;

  // Block submission early for fields the backend strictly requires, so the
  // user gets a precise inline message instead of a generic round-trip error
  // like '"name" is required'.
  const formValidationError: string | null = (() => {
    if (!newInstance.name.trim()) return 'Instance name is required.';
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
    if (useExistingDb || createDbAccount) {
      if (!newInstance.database.user.trim())
        return 'DHIS2 role username is required.';
      if (!newInstance.database.password)
        return 'DHIS2 role password is required.';
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
    if (deleteIfExists) {
      setConfirmDeleteOpen(true);
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
            user: newInstance.database.user,
            password: newInstance.database.password,
          }
        : undefined,
      dhisConfTemplate:
        customizeDhisConf && dhisConfTemplate !== DEFAULT_DHIS_CONF_TEMPLATE
          ? dhisConfTemplate
          : undefined,
      deleteIfExists: deleteIfExists || undefined,
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
              return {
                ...prev,
                name: newName,
                database: {
                  ...prev.database,
                  name: dbNameInSync ? newName : prev.database.name,
                },
              };
            });
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
              onChange={e =>
                setNewInstance({ ...newInstance, version: e.target.value })
              }
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
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  tomcatVersion: e.target.value as '9' | '10',
                })
              }
              className={classes.formField}
              helperText="DHIS2 2.40/2.41 need 9 (javax); v42+ needs 10 (jakarta)."
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
                    cpu: parseInt(e.target.value, 10) || 1,
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
              type="number"
              label="Memory (MB)"
              value={newInstance.resources.memory}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  resources: {
                    ...newInstance.resources,
                    memory: parseInt(e.target.value, 10) || 1024,
                  },
                })
              }
              className={classes.formField}
              inputProps={{ min: 1024, max: 65536, step: 1024 }}
            />
          </Grid>
          <Grid item xs={4}>
            <TextField
              fullWidth
              type="number"
              label="Storage (GB)"
              value={newInstance.resources.storage}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  resources: {
                    ...newInstance.resources,
                    storage: parseInt(e.target.value, 10) || 20,
                  },
                })
              }
              className={classes.formField}
              inputProps={{ min: 20, max: 1000 }}
            />
          </Grid>
        </Grid>
        <Grid container spacing={2}>
          <Grid item xs={6}>
            <TextField
              fullWidth
              label="Java heap (Xmx)"
              value={dhis2Settings.javaHeap}
              onChange={e =>
                setDhis2Settings({
                  ...dhis2Settings,
                  javaHeap: e.target.value,
                })
              }
              className={classes.formField}
              helperText="e.g. 4g"
            />
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
                  if (!next) {
                    setAvailableDatabases([]);
                    setDatabasesError(null);
                    setDbTestResult(null);
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
            disabled={loadingDatabases}
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
        {useExistingDb ? (
          <FormControl
            fullWidth
            className={classes.formField}
            required
            error={Boolean(databasesError)}
          >
            <InputLabel>Database</InputLabel>
            <Select
              value={newInstance.database.name}
              onChange={e =>
                setNewInstance({
                  ...newInstance,
                  database: {
                    ...newInstance.database,
                    name: e.target.value as string,
                  },
                })
              }
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
        ) : (
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
        <FormControlLabel
          control={
            <Checkbox
              checked={createDbAccount}
              onChange={e => setCreateDbAccount(e.target.checked)}
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
        {(useExistingDb || createDbAccount) && (
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
                required
                helperText={
                  createDbAccount
                    ? 'PostgreSQL role to be created on the shared host and used by DHIS2 at runtime.'
                    : 'PostgreSQL role DHIS2 will authenticate as at runtime (must already exist unless you tick "Create a new database account" above).'
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
                required
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip
                        title={
                          showDbPassword
                            ? 'Hide password'
                            : 'Show password'
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
          <strong>{settingsService.load().proxmox.vmidStart || 200}</strong>{' '}
          and creating <strong>{newInstance.name || '(unnamed)'}</strong>?
        </Typography>
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
