import React, { useState, useEffect } from 'react';
import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Button,
  Chip,
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
  InputLabel,
  Select,
  Switch,
  Checkbox,
  InputAdornment,
  Tooltip,
  Divider,
  Paper,
  Tabs,
  Tab,
  CircularProgress,
  makeStyles,
} from '@material-ui/core';
import {
  Header,
  Page,
  Content,
  ContentHeader,
  SupportButton,
} from '@backstage/core-components';
import AddIcon from '@material-ui/icons/Add';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import RefreshIcon from '@material-ui/icons/Refresh';
import DeleteIcon from '@material-ui/icons/Delete';
import SettingsIcon from '@material-ui/icons/Settings';
import DescriptionIcon from '@material-ui/icons/Description';
import StorageIcon from '@material-ui/icons/Storage';
import CloudIcon from '@material-ui/icons/Cloud';
import DnsIcon from '@material-ui/icons/Dns';
import SdStorageIcon from '@material-ui/icons/SdStorage';
import DeviceHubIcon from '@material-ui/icons/DeviceHub';
import SettingsBackupRestoreIcon from '@material-ui/icons/SettingsBackupRestore';
import VpnKeyIcon from '@material-ui/icons/VpnKey';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import {
  DHIS2Instance,
  CreateInstanceRequest,
  ProxmoxNode,
  ProxyServerSettings,
  DHIS2DefaultsSettings,
  RestoreSource,
} from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { validateRestoreSource } from '../services/restoreService';
import { fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { DHIS2LogsPanel } from './DHIS2LogsPanel';
import { ProxmoxClusterPanel } from './ProxmoxClusterPanel';
import { RestoreSourcePicker } from './RestoreSourcePicker';
import { RestoreInstanceDialog } from './RestoreInstanceDialog';

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  cardContent: {
    flexGrow: 1,
  },
  statCard: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: theme.spacing(3),
    gap: theme.spacing(1),
  },
  statIcon: {
    fontSize: '3rem',
  },
  statValue: {
    fontSize: '2.25rem',
    fontWeight: 'bold',
    lineHeight: 1.1,
    color: theme.palette.primary.main,
    wordBreak: 'keep-all',
    whiteSpace: 'nowrap',
  },
  statLabel: {
    fontSize: '0.95rem',
    minHeight: '2.4em',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  actionButtons: {
    display: 'flex',
    gap: theme.spacing(1),
    marginTop: theme.spacing(2),
  },
  instanceCard: {
    marginBottom: theme.spacing(2),
    borderLeft: `4px solid ${theme.palette.primary.main}`,
  },
  formField: {
    marginBottom: theme.spacing(2),
  },
}));

// Cryptographically strong password generator: 24 characters drawn from a
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

// Default `dhis.conf` Jinja template. Kept verbatim in sync with
// plugins/dhis2/ansible/roles/dhis2/templates/dhis.conf.j2 so that the
// in-dialog editor opens with the exact content the playbook would render
// if no override were provided.
const DEFAULT_DHIS_CONF_TEMPLATE = `{# Rendered by the dhis2 Ansible role. Do not edit by hand. #}
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

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`tabpanel-${index}`}
      aria-labelledby={`tab-${index}`}
      {...other}
    >
      {value === index && <Box p={3}>{children}</Box>}
    </div>
  );
}

export const DHIS2Page = () => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const [instances, setInstances] = useState<DHIS2Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tabValue, setTabValue] = useState(0);
  const [nodes, setNodes] = useState<ProxmoxNode[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [logsDialog, setLogsDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
    lines: string[];
    loading: boolean;
  }>({ open: false, instance: null, lines: [], loading: false });

  // Restore-from-backup state for the Create dialog.
  const [restoreEnabled, setRestoreEnabled] = useState(false);
  const [restoreSource, setRestoreSource] = useState<RestoreSource | undefined>(
    undefined,
  );

  // Post-create restore dialog (Restore icon on an existing instance card).
  const [restoreDialog, setRestoreDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
  }>({ open: false, instance: null });

  // "Create new database account" option in the Create dialog.
  const [createDbAccount, setCreateDbAccount] = useState(false);
  const [showDbPassword, setShowDbPassword] = useState(false);
  const [newDbUser, setNewDbUser] = useState('');
  const [newDbPassword, setNewDbPassword] = useState('');
  const [showNewDbPassword, setShowNewDbPassword] = useState(false);

  // "Customize dhis.conf template" option in the Create dialog.
  const [customizeDhisConf, setCustomizeDhisConf] = useState(false);
  const [dhisConfTemplate, setDhisConfTemplate] = useState(
    DEFAULT_DHIS_CONF_TEMPLATE,
  );

  // Reverse proxy + DHIS2/Postgres/backup settings, captured per-instance in
  // the Create dialog and pre-filled from the saved plugin defaults.
  const [proxySettings, setProxySettings] = useState<ProxyServerSettings>(
    () => settingsService.load().proxy,
  );
  const [dhis2Settings, setDhis2Settings] = useState<DHIS2DefaultsSettings>(
    () => settingsService.load().dhis2,
  );

  const [newInstance, setNewInstance] = useState<CreateInstanceRequest>(() => {
    const { proxy } = settingsService.load();
    return {
      name: '',
      domain: '',
      version: '',
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
      adminPassword: '',
      proxyOverride: {
        mode: proxy.mode,
        baseDomain: proxy.baseDomain,
      },
    };
  });

  useEffect(() => {
    loadInstances();
    loadNodes();
    loadVersions();
  }, []);

  const loadInstances = async () => {
    setLoading(true);
    try {
      const data = await dhis2Service.getInstances();
      setInstances(data);
    } catch (error) {
      console.error('Failed to load instances:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadNodes = async () => {
    try {
      const data = await dhis2Service.getNodes(undefined, backstageFetch);
      setNodes(data);
      if (data.length > 0 && !newInstance.node) {
        setNewInstance(prev => ({ ...prev, node: data[0].node }));
      }
    } catch (error) {
      console.error('Failed to load nodes:', error);
    }
  };

  const loadVersions = async () => {
    try {
      const data = await dhis2Service.getVersions();
      setVersions(data);
      if (data.length > 0 && !newInstance.version) {
        setNewInstance(prev => ({ ...prev, version: data[0] }));
      }
    } catch (error) {
      console.error('Failed to load versions:', error);
    }
  };

  const handleCreateInstance = async () => {
    try {
      const payload: CreateInstanceRequest = {
        ...newInstance,
        restore: restoreEnabled ? restoreSource : undefined,
        newDbAccount: createDbAccount
          ? { user: newDbUser, password: newDbPassword }
          : undefined,
        dhisConfTemplate:
          customizeDhisConf &&
          dhisConfTemplate !== DEFAULT_DHIS_CONF_TEMPLATE
            ? dhisConfTemplate
            : undefined,
        proxySettings,
        dhis2Settings,
      };
      await dhis2Service.createInstance(payload);
      setCreateDialogOpen(false);
      loadInstances();
      // Reset form
      const { proxy } = settingsService.load();
      setNewInstance({
        name: '',
        domain: '',
        version: versions[0] || '',
        node: nodes[0]?.node || '',
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
        adminPassword: '',
        proxyOverride: {
          mode: proxy.mode,
          baseDomain: proxy.baseDomain,
        },
      });
      setRestoreEnabled(false);
      setRestoreSource(undefined);
      setCreateDbAccount(false);
      setShowDbPassword(false);
      setNewDbUser('');
      setNewDbPassword('');
      setShowNewDbPassword(false);
      setCustomizeDhisConf(false);
      setDhisConfTemplate(DEFAULT_DHIS_CONF_TEMPLATE);
      const fresh = settingsService.load();
      setProxySettings(fresh.proxy);
      setDhis2Settings(fresh.dhis2);
    } catch (error) {
      console.error('Failed to create instance:', error);
    }
  };

  const restoreValidationError = restoreEnabled
    ? validateRestoreSource(restoreSource) ?? (restoreSource ? null : 'Pick a backup source.')
    : null;

  const handleStartInstance = async (id: string) => {
    try {
      await dhis2Service.startInstance(id);
      loadInstances();
    } catch (error) {
      console.error('Failed to start instance:', error);
    }
  };

  const handleStopInstance = async (id: string) => {
    try {
      await dhis2Service.stopInstance(id);
      loadInstances();
    } catch (error) {
      console.error('Failed to stop instance:', error);
    }
  };

  const handleRestartInstance = async (id: string) => {
    try {
      await dhis2Service.restartInstance(id);
      loadInstances();
    } catch (error) {
      console.error('Failed to restart instance:', error);
    }
  };

  const handleDeleteInstance = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this instance?')) {
      try {
        await dhis2Service.deleteInstance(id);
        loadInstances();
      } catch (error) {
        console.error('Failed to delete instance:', error);
      }
    }
  };

  const handleViewInstanceLogs = async (instance: DHIS2Instance) => {
    setLogsDialog({ open: true, instance, lines: [], loading: true });
    try {
      const lines = await dhis2Service.getInstanceLogs(instance.id, 200);
      setLogsDialog(prev => ({ ...prev, lines, loading: false }));
    } catch (error) {
      console.error('Failed to load instance logs:', error);
      setLogsDialog(prev => ({
        ...prev,
        lines: ['Failed to load logs. See console for details.'],
        loading: false,
      }));
    }
  };

  const refreshInstanceLogs = async () => {
    if (!logsDialog.instance) return;
    setLogsDialog(prev => ({ ...prev, loading: true }));
    try {
      const lines = await dhis2Service.getInstanceLogs(
        logsDialog.instance.id,
        200,
      );
      setLogsDialog(prev => ({ ...prev, lines, loading: false }));
    } catch (error) {
      console.error('Failed to refresh instance logs:', error);
      setLogsDialog(prev => ({ ...prev, loading: false }));
    }
  };

  const closeLogsDialog = () =>
    setLogsDialog({ open: false, instance: null, lines: [], loading: false });

  const getStatusColor = (status: string): 'default' | 'primary' | 'secondary' => {
    switch (status) {
      case 'running':
        return 'primary';
      case 'stopped':
        return 'default';
      case 'provisioning':
        return 'secondary';
      default:
        return 'default';
    }
  };

  const runningInstances = instances.filter(i => i.status === 'running').length;

  // Cluster-wide totals derived from the live Proxmox node list. These
  // update automatically whenever `nodes` is refreshed (mount, manual
  // refresh, or after settings changes in the Proxmox Cluster tab).
  const totalVCPUs = nodes.reduce((sum, n) => sum + (n.maxcpu ?? 0), 0);
  const totalMemoryBytes = nodes.reduce((sum, n) => sum + (n.maxmem ?? 0), 0);
  const totalDiskBytes = nodes.reduce((sum, n) => sum + (n.maxdisk ?? 0), 0);
  const onlineNodes = nodes.filter(n => n.status === 'online').length;

  const bytesToGB = (b: number) => b / 1024 ** 3;
  const formatCapacity = (bytes: number) => {
    const gb = bytesToGB(bytes);
    if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
    return `${gb.toFixed(0)} GB`;
  };

  const refreshOverview = () => {
    loadInstances();
    loadNodes();
  };

  return (
    <Page themeId="tool">
      <Header title="DHIS2 Orchestration" subtitle="Manage DHIS2 instances on Proxmox LXC containers">
        <SupportButton>Orchestrate and manage DHIS2 instances on your Proxmox cluster</SupportButton>
      </Header>
      <Content>
        <ContentHeader title="Overview">
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
          >
            Create Instance
          </Button>
          <IconButton onClick={refreshOverview} color="primary">
            <RefreshIcon />
          </IconButton>
        </ContentHeader>

        {/* Tabs */}
        <Paper style={{ marginBottom: 24 }}>
          <Tabs value={tabValue} onChange={(_e, newValue) => setTabValue(newValue)} indicatorColor="primary">
            <Tab label="Instances" />
            <Tab label="Proxmox Cluster" />
            <Tab label="Proxy" />
            <Tab label="Logs" />
          </Tabs>
        </Paper>

        {/* Statistics */}
        <Grid container spacing={3} alignItems="stretch" style={{ marginBottom: 24 }}>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <StorageIcon className={classes.statIcon} style={{ color: '#1976d2' }} />
              <Typography className={classes.statValue}>{instances.length}</Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Total Instances
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <PlayArrowIcon className={classes.statIcon} style={{ color: '#4caf50' }} />
              <Typography className={classes.statValue}>{runningInstances}</Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Running
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <CloudIcon className={classes.statIcon} style={{ color: '#ff9800' }} />
              <Typography className={classes.statValue}>{totalVCPUs}</Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Total vCPUs
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <DnsIcon className={classes.statIcon} style={{ color: '#9c27b0' }} />
              <Typography className={classes.statValue}>
                {formatCapacity(totalMemoryBytes)}
              </Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Total Memory
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <SdStorageIcon className={classes.statIcon} style={{ color: '#00897b' }} />
              <Typography className={classes.statValue}>
                {formatCapacity(totalDiskBytes)}
              </Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Storage Capacity
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={4} lg={2}>
            <Card className={classes.statCard}>
              <DeviceHubIcon className={classes.statIcon} style={{ color: '#3949ab' }} />
              <Typography className={classes.statValue}>
                {onlineNodes}
                <Typography
                  component="span"
                  style={{ fontSize: '1.25rem', color: 'inherit', opacity: 0.6 }}
                >
                  {` / ${nodes.length}`}
                </Typography>
              </Typography>
              <Typography variant="subtitle1" color="textSecondary" className={classes.statLabel}>
                Cluster Nodes
              </Typography>
            </Card>
          </Grid>
        </Grid>

        {/* Tab panels */}
        <Paper>
          {/* Instances Tab */}
          <TabPanel value={tabValue} index={0}>
            {loading ? (
              <Box display="flex" justifyContent="center" p={4}>
                <CircularProgress />
              </Box>
            ) : instances.length === 0 ? (
              <Box textAlign="center" p={4}>
                <Typography variant="h6" color="textSecondary">
                  No DHIS2 instances found
                </Typography>
                <Typography variant="body2" color="textSecondary" paragraph>
                  Create your first DHIS2 instance to get started
                </Typography>
                <Button variant="contained" color="primary" startIcon={<AddIcon />} onClick={() => setCreateDialogOpen(true)}>
                  Create Instance
                </Button>
              </Box>
            ) : (
              <Grid container spacing={3}>
                {instances.map(instance => (
                  <Grid item xs={12} key={instance.id}>
                    <Card className={classes.instanceCard}>
                      <CardContent>
                        <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                          <Box>
                            <Typography variant="h5" gutterBottom>
                              {instance.name}
                              <Chip
                                label={instance.status}
                                color={getStatusColor(instance.status)}
                                size="small"
                                className={classes.statusChip}
                              />
                            </Typography>
                            <Typography variant="body2" color="textSecondary">
                              <strong>Version:</strong> {instance.version} | <strong>Node:</strong> {instance.node} | <strong>VMID:</strong> {instance.vmid}
                            </Typography>
                            <Typography variant="body2" color="textSecondary">
                              <strong>URL:</strong> <a href={instance.url} target="_blank" rel="noopener noreferrer">{instance.domain}</a>
                            </Typography>
                            <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>
                              <strong>Resources:</strong> {instance.resources.cpu} vCPU | {(instance.resources.memory / 1024).toFixed(1)} GB RAM | {instance.resources.storage} GB Storage
                            </Typography>
                            <Typography variant="body2" color="textSecondary">
                              <strong>Database:</strong> {instance.database.name} (User: {instance.database.user})
                            </Typography>
                          </Box>
                          <Box className={classes.actionButtons}>
                            {instance.status === 'stopped' && (
                              <IconButton color="primary" onClick={() => handleStartInstance(instance.id)} title="Start">
                                <PlayArrowIcon />
                              </IconButton>
                            )}
                            {instance.status === 'running' && (
                              <IconButton color="secondary" onClick={() => handleStopInstance(instance.id)} title="Stop">
                                <StopIcon />
                              </IconButton>
                            )}
                            {instance.status === 'running' && (
                              <IconButton onClick={() => handleRestartInstance(instance.id)} title="Restart">
                                <RefreshIcon />
                              </IconButton>
                            )}
                            <IconButton onClick={() => handleViewInstanceLogs(instance)} title="View Logs">
                              <DescriptionIcon />
                            </IconButton>
                            <IconButton
                              onClick={() =>
                                setRestoreDialog({ open: true, instance })
                              }
                              title="Restore from backup"
                            >
                              <SettingsBackupRestoreIcon />
                            </IconButton>
                            <IconButton title="Settings">
                              <SettingsIcon />
                            </IconButton>
                            <IconButton color="secondary" onClick={() => handleDeleteInstance(instance.id)} title="Delete">
                              <DeleteIcon />
                            </IconButton>
                          </Box>
                        </Box>
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            )}
          </TabPanel>

          {/* Proxmox Cluster Tab */}
          <TabPanel value={tabValue} index={1}>
            <ProxmoxClusterPanel
              instances={instances}
              onNodesChange={setNodes}
            />
          </TabPanel>

          {/* Proxy Tab */}
          <TabPanel value={tabValue} index={2}>
            {(() => {
              const proxyDefaults = settingsService.load().proxy;
              if (loading) {
                return (
                  <Box display="flex" justifyContent="center" p={4}>
                    <CircularProgress />
                  </Box>
                );
              }
              if (instances.length === 0) {
                return (
                  <Box textAlign="center" p={4}>
                    <Typography variant="h6" color="textSecondary">
                      No proxy mappings
                    </Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      Create a DHIS2 instance to publish it through the
                      reverse proxy.
                    </Typography>
                  </Box>
                );
              }
              return (
                <>
                  <Box mb={2}>
                    <Typography variant="h6" gutterBottom>
                      Reverse Proxy
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Proxy host{' '}
                      <strong>{proxyDefaults.host || '—'}</strong> routes
                      traffic to each DHIS2 instance using the configured
                      base domain and SSL settings. Per-instance overrides
                      set in the Create dialog take precedence over these
                      defaults.
                    </Typography>
                  </Box>
                  <Grid container spacing={3}>
                    {instances.map(instance => {
                      const scheme = proxyDefaults.forceHttps
                        ? 'https'
                        : 'http';
                      const publicUrl =
                        proxyDefaults.mode === 'subdomain'
                          ? `${scheme}://${instance.name}.${proxyDefaults.baseDomain}`
                          : `${scheme}://${proxyDefaults.baseDomain}/${instance.name}`;
                      return (
                        <Grid item xs={12} key={instance.id}>
                          <Card className={classes.instanceCard}>
                            <CardContent>
                              <Box
                                display="flex"
                                justifyContent="space-between"
                                alignItems="flex-start"
                              >
                                <Box>
                                  <Typography variant="h5" gutterBottom>
                                    {instance.name}
                                    <Chip
                                      label={instance.status}
                                      color={getStatusColor(instance.status)}
                                      size="small"
                                      className={classes.statusChip}
                                    />
                                    <Chip
                                      label={
                                        proxyDefaults.mode === 'subdomain'
                                          ? 'subdomain'
                                          : 'path'
                                      }
                                      size="small"
                                      variant="outlined"
                                      className={classes.statusChip}
                                    />
                                    {proxyDefaults.forceHttps && (
                                      <Chip
                                        label="HTTPS"
                                        color="primary"
                                        size="small"
                                        className={classes.statusChip}
                                      />
                                    )}
                                    {proxyDefaults.enableHsts && (
                                      <Chip
                                        label="HSTS"
                                        size="small"
                                        variant="outlined"
                                        className={classes.statusChip}
                                      />
                                    )}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                  >
                                    <strong>Public URL:</strong>{' '}
                                    <a
                                      href={publicUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {publicUrl}
                                    </a>
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                  >
                                    <strong>Domain:</strong> {instance.domain}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                    style={{ marginTop: 8 }}
                                  >
                                    <strong>Upstream:</strong> Container{' '}
                                    {instance.vmid}:{proxyDefaults.upstreamPort}{' '}
                                    on node {instance.node}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                  >
                                    <strong>Proxy host:</strong>{' '}
                                    {proxyDefaults.host || '—'} (SSH{' '}
                                    {proxyDefaults.sshUser}@
                                    {proxyDefaults.host || '?'}:
                                    {proxyDefaults.sshPort})
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                  >
                                    <strong>SSL:</strong>{' '}
                                    {proxyDefaults.sslProvider === 'letsencrypt'
                                      ? `Let's Encrypt (${proxyDefaults.letsencryptEmail || 'no email'})`
                                      : proxyDefaults.sslProvider === 'manual'
                                        ? `Manual (${proxyDefaults.sslCertPath || 'cert?'})`
                                        : 'None (HTTP only)'}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="textSecondary"
                                  >
                                    <strong>Nginx config:</strong>{' '}
                                    {proxyDefaults.nginxConfigPath}/
                                    {instance.name}.conf
                                  </Typography>
                                </Box>
                                <Box className={classes.actionButtons}>
                                  <IconButton
                                    title="Open public URL"
                                    onClick={() =>
                                      window.open(
                                        publicUrl,
                                        '_blank',
                                        'noopener,noreferrer',
                                      )
                                    }
                                  >
                                    <CloudIcon />
                                  </IconButton>
                                  <IconButton
                                    title="View instance logs"
                                    onClick={() =>
                                      handleViewInstanceLogs(instance)
                                    }
                                  >
                                    <DescriptionIcon />
                                  </IconButton>
                                </Box>
                              </Box>
                            </CardContent>
                          </Card>
                        </Grid>
                      );
                    })}
                  </Grid>
                </>
              );
            })()}
          </TabPanel>

          {/* Logs Tab */}
          <TabPanel value={tabValue} index={3}>
            <DHIS2LogsPanel />
          </TabPanel>
        </Paper>

        {/* Instance Logs Dialog */}
        <Dialog open={logsDialog.open} onClose={closeLogsDialog} maxWidth="md" fullWidth>
          <DialogTitle>
            <Box display="flex" alignItems="center" justifyContent="space-between">
              <span>
                Logs
                {logsDialog.instance ? ` — ${logsDialog.instance.name}` : ''}
              </span>
              <IconButton
                size="small"
                onClick={refreshInstanceLogs}
                disabled={logsDialog.loading}
                title="Refresh"
              >
                <RefreshIcon />
              </IconButton>
            </Box>
          </DialogTitle>
          <DialogContent dividers>
            {logsDialog.loading ? (
              <Box display="flex" justifyContent="center" p={4}>
                <CircularProgress />
              </Box>
            ) : (
              <Box
                component="pre"
                style={{
                  margin: 0,
                  padding: 12,
                  backgroundColor: '#0e0e0e',
                  color: '#e0e0e0',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  maxHeight: 480,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  borderRadius: 4,
                }}
              >
                {logsDialog.lines.length > 0
                  ? logsDialog.lines.join('\n')
                  : 'No log output.'}
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeLogsDialog}>Close</Button>
          </DialogActions>
        </Dialog>

        {/* Create Instance Dialog */}
        <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} maxWidth="md" fullWidth>
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
                // Keep the suggested "new account" username in sync with
                // the instance name while the user hasn't customised it.
                setNewDbUser(prev =>
                  !prev || prev === newInstance.name ? newName : prev,
                );
              }}
              className={classes.formField}
              helperText="Used as the proxy path segment and as the default database name"
              required
            />
            <TextField
              fullWidth
              label="Domain Name"
              value={newInstance.domain}
              onChange={e => setNewInstance({ ...newInstance, domain: e.target.value })}
              className={classes.formField}
              helperText="e.g., dhis2-prod.example.com"
              required
            />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  select
                  label="DHIS2 Version"
                  value={newInstance.version}
                  onChange={e => setNewInstance({ ...newInstance, version: e.target.value })}
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
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  select
                  label="Proxmox Node"
                  value={newInstance.node}
                  onChange={e => setNewInstance({ ...newInstance, node: e.target.value })}
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
                  onChange={e => setNewInstance({
                    ...newInstance,
                    resources: { ...newInstance.resources, cpu: parseInt(e.target.value) || 1 },
                  })}
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
                  onChange={e => setNewInstance({
                    ...newInstance,
                    resources: { ...newInstance.resources, memory: parseInt(e.target.value) || 1024 },
                  })}
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
                  onChange={e => setNewInstance({
                    ...newInstance,
                    resources: { ...newInstance.resources, storage: parseInt(e.target.value) || 20 },
                  })}
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
                      tomcatPort:
                        parseInt(e.target.value, 10) || 8080,
                    })
                  }
                  className={classes.formField}
                />
              </Grid>
            </Grid>
            <TextField
              fullWidth
              type="password"
              label="DHIS2 Admin Password"
              value={newInstance.adminPassword}
              onChange={e => setNewInstance({ ...newInstance, adminPassword: e.target.value })}
              className={classes.formField}
              helperText={
                restoreEnabled
                  ? 'Ignored when restoring from a backup (the restored admin password is preserved).'
                  : 'Password for the DHIS2 admin user'
              }
              disabled={restoreEnabled}
              required={!restoreEnabled}
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
              Tick to override the bundled <code>dhis.conf</code> Jinja
              template. Placeholders such as{' '}
              <code>{'{{ dhis2_db_host }}'}</code> remain rendered by the
              Ansible role at provisioning time.
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
                      onClick={() =>
                        setDhisConfTemplate(DEFAULT_DHIS_CONF_TEMPLATE)
                      }
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
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ marginBottom: 8 }}
            >
              Provide credentials for an existing PostgreSQL role with
              privileges on the database below.
            </Typography>
            <TextField
              fullWidth
              label="Database Name"
              value={newInstance.database.name}
              onChange={e => setNewInstance({
                ...newInstance,
                database: { ...newInstance.database, name: e.target.value },
              })}
              className={classes.formField}
              required
            />
            <TextField
              fullWidth
              label="Database Username"
              value={newInstance.database.user}
              onChange={e => setNewInstance({
                ...newInstance,
                database: { ...newInstance.database, user: e.target.value },
              })}
              className={classes.formField}
              required
            />
            <TextField
              fullWidth
              type={showDbPassword ? 'text' : 'password'}
              label="Database Password"
              value={newInstance.database.password}
              onChange={e => setNewInstance({
                ...newInstance,
                database: { ...newInstance.database, password: e.target.value },
              })}
              className={classes.formField}
              required
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title={showDbPassword ? 'Hide password' : 'Show password'}>
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
            <FormControlLabel
              control={
                <Checkbox
                  checked={createDbAccount}
                  onChange={e => {
                    const next = e.target.checked;
                    setCreateDbAccount(next);
                    if (next) {
                      // Pre-fill sensible defaults the user can still edit:
                      // username defaults to the instance name and a strong
                      // password is generated.
                      setNewDbUser(prev => prev || newInstance.name || 'dhis2');
                      setNewDbPassword(prev => prev || generateStrongPassword());
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
              {createDbAccount
                ? 'A new PostgreSQL role will be created using the credentials below. The role above is used to perform the provisioning.'
                : 'Tick to create a new PostgreSQL role in addition to using the credentials above. The new role will be granted ownership of the database.'}
            </Typography>
            {createDbAccount && (
              <>
                <TextField
                  fullWidth
                  label="New Database Username"
                  value={newDbUser}
                  onChange={e => setNewDbUser(e.target.value)}
                  className={classes.formField}
                  helperText="Defaults to the instance name; rename if your conventions differ."
                  required
                />
                <TextField
                  fullWidth
                  type={showNewDbPassword ? 'text' : 'password'}
                  label="New Database Password"
                  value={newDbPassword}
                  onChange={e => setNewDbPassword(e.target.value)}
                  className={classes.formField}
                  helperText="A strong password is suggested. Use the key icon to regenerate."
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
                        <Tooltip title="Copy password to clipboard">
                          <IconButton
                            size="small"
                            onClick={() => {
                              if (newDbPassword) {
                                navigator.clipboard
                                  ?.writeText(newDbPassword)
                                  .catch(() => {});
                              }
                            }}
                          >
                            <FileCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  }}
                />
              </>
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
                  Note: the restored database keeps its own admin user and
                  password. The "DHIS2 Admin Password" set above is ignored
                  when restoring from a backup.
                </Typography>
              </Box>
            )}
            <Divider style={{ margin: '16px 0' }} />
            <Typography variant="subtitle2" color="textSecondary" gutterBottom>
              Shared PostgreSQL (leave host blank to install per-instance)
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
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
                />
              </Grid>
              <Grid item xs={6} md={2}>
                <TextField
                  fullWidth
                  type="number"
                  label="Port"
                  value={dhis2Settings.postgresPort}
                  onChange={e =>
                    setDhis2Settings({
                      ...dhis2Settings,
                      postgresPort:
                        parseInt(e.target.value, 10) || 5432,
                    })
                  }
                  className={classes.formField}
                />
              </Grid>
              <Grid item xs={6} md={4}>
                <TextField
                  fullWidth
                  label="Admin user"
                  value={dhis2Settings.postgresAdminUser}
                  onChange={e =>
                    setDhis2Settings({
                      ...dhis2Settings,
                      postgresAdminUser: e.target.value,
                    })
                  }
                  className={classes.formField}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  type="password"
                  label="Admin password"
                  value={dhis2Settings.postgresAdminPassword}
                  onChange={e =>
                    setDhis2Settings({
                      ...dhis2Settings,
                      postgresAdminPassword: e.target.value,
                    })
                  }
                  className={classes.formField}
                />
              </Grid>
            </Grid>
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
                      backupRetentionDays:
                        parseInt(e.target.value, 10) || 7,
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
            <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
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
                              authMethod: e.target.value as
                                | 'ssh-key'
                                | 'password',
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
                        helperText="e.g. /etc/nginx/conf.d"
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
                            upstreamPort:
                              parseInt(e.target.value, 10) || 8080,
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
            <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreateInstance}
              color="primary"
              variant="contained"
              disabled={Boolean(restoreValidationError)}
            >
              Create Instance
            </Button>
          </DialogActions>
        </Dialog>

        {/* Restore-from-backup for an existing instance */}
        <RestoreInstanceDialog
          open={restoreDialog.open}
          instance={restoreDialog.instance}
          nodes={nodes}
          onClose={() => setRestoreDialog({ open: false, instance: null })}
        />
      </Content>
    </Page>
  );
};
