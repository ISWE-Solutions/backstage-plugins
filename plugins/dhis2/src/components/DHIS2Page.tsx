import React, { useState, useEffect } from 'react';
import {
  Box,
  Grid,
  Card,
  Typography,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Paper,
  Tabs,
  Tab,
  CircularProgress,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import {
  Header,
  Page,
  Content,
  ContentHeader,
  SupportButton,
} from '@backstage/core-components';
import AddIcon from '@material-ui/icons/Add';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import RefreshIcon from '@material-ui/icons/Refresh';
import StorageIcon from '@material-ui/icons/Storage';
import CloudIcon from '@material-ui/icons/Cloud';
import DnsIcon from '@material-ui/icons/Dns';
import SdStorageIcon from '@material-ui/icons/SdStorage';
import DeviceHubIcon from '@material-ui/icons/DeviceHub';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorOutlineIcon from '@material-ui/icons/ErrorOutline';
import RadioButtonUncheckedIcon from '@material-ui/icons/RadioButtonUnchecked';
import {
  DHIS2Instance,
  ProxmoxNode,
} from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { fetchApiRef, useApi, discoveryApiRef } from '@backstage/core-plugin-api';
import { DHIS2LogsPanel } from './DHIS2LogsPanel';
import { ProxmoxClusterPanel } from './ProxmoxClusterPanel';
import { RestoreInstanceDialog } from './RestoreInstanceDialog';
import { DHIS2InstancesPanel } from './DHIS2InstancesPanel';
import { DHIS2ProxyPanel } from './DHIS2ProxyPanel';
import {
  CreateInstanceDialog,
  CreateInstanceSubmitPayload,
} from './CreateInstanceDialog';

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
  const discoveryApi = useApi(discoveryApiRef);
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

  // Post-create restore dialog (Restore icon on an existing instance card).
  const [restoreDialog, setRestoreDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
  }>({ open: false, instance: null });

  // Provisioning progress dialog state. Driven by `handleCreateInstance`.
  type ProvisionStepStatus = 'pending' | 'running' | 'done' | 'error';
  interface ProvisionStep {
    key: string;
    label: string;
    detail?: string;
    status: ProvisionStepStatus;
  }
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provisionSteps, setProvisionSteps] = useState<ProvisionStep[]>([]);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionDone, setProvisionDone] = useState(false);
  const [provisionInstanceName, setProvisionInstanceName] = useState('');
  const [provisionLog, setProvisionLog] = useState<string[]>([]);

  useEffect(() => {
    loadInstances();
    loadNodes();
    loadVersions();
  }, []);

  const loadInstances = async () => {
    setLoading(true);
    try {
      const data = await dhis2Service.getInstances();
      // Merge in instances that the backend has actually provisioned.
      try {
        const baseUrl = await discoveryApi.getBaseUrl('dhis2');
        const persisted = await dhis2Service.getPersistedInstances(
          baseUrl,
          backstageFetch,
        );
        const byId = new Map<string, DHIS2Instance>();
        for (const inst of data) byId.set(inst.id, inst);
        for (const inst of persisted) byId.set(inst.id, inst);
        setInstances(Array.from(byId.values()));
      } catch {
        // Backend unreachable — fall back to mock list.
        setInstances(data);
      }
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
    } catch (error) {
      console.error('Failed to load nodes:', error);
    }
  };

  const loadVersions = async () => {
    try {
      const data = await dhis2Service.getVersions();
      setVersions(data);
    } catch (error) {
      console.error('Failed to load versions:', error);
    }
  };

  const appendProvisionLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setProvisionLog(prev => [...prev, `[${ts}] ${line}`]);
  };

  const updateStep = (
    key: string,
    status: ProvisionStepStatus,
    detail?: string,
  ) => {
    setProvisionSteps(prev =>
      prev.map(s =>
        s.key === key ? { ...s, status, detail: detail ?? s.detail } : s,
      ),
    );
  };

  const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

  // Log-line markers from provision-instance.sh that we use to advance the
  // visible step list. Order matters: later matches "complete" earlier steps.
  const STEP_MARKERS: Array<{ pattern: RegExp; advanceTo: string }> = [
    { pattern: /Phase 1 — creating LXC container/i, advanceTo: 'container' },
    { pattern: /container IP:/i, advanceTo: 'packages' },
    { pattern: /Phase 2 — rendering inventory/i, advanceTo: 'packages' },
    { pattern: /running ansible-playbook/i, advanceTo: 'packages' },
    { pattern: /Phase 3 — configuring central Nginx/i, advanceTo: 'proxy' },
    { pattern: /DHIS2 provisioning complete/i, advanceTo: 'finalize' },
  ];

  // Advance the step list so all steps up to (but not including) `key` are
  // marked 'done' and `key` itself becomes 'running'. Idempotent.
  const advanceSteps = (key: string) => {
    setProvisionSteps(prev => {
      const idx = prev.findIndex(s => s.key === key);
      if (idx < 0) return prev;
      return prev.map((s, i) => {
        if (i < idx && s.status !== 'error') return { ...s, status: 'done' };
        if (i === idx && s.status === 'pending') return { ...s, status: 'running' };
        return s;
      });
    });
  };

  const handleCreateInstance = async (payload: CreateInstanceSubmitPayload) => {
    const { request, derivedDomain, proxySettings } = payload;

    // Steps modelled on provision-instance.sh phases.
    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'container', label: `Phase 1 — creating LXC container (vmid will be allocated by orchestrator)`, status: 'pending' },
      { key: 'packages', label: `Phase 2 — running Ansible (DHIS2 ${request.version} + PostgreSQL)`, status: 'pending' },
      { key: 'proxy', label: `Phase 3 — configuring Nginx for ${derivedDomain}`, status: 'pending' },
      { key: 'finalize', label: 'Finalizing instance', status: 'pending' },
    ];

    setProvisionInstanceName(request.name);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    appendProvisionLog(`Starting provisioning for "${request.name}".`);

    // VMID and email come from saved settings — the script requires both.
    const settings = settingsService.load();
    const vmid = settings.proxmox.vmidStart || 200;
    const email = proxySettings.letsencryptEmail || settings.proxy.letsencryptEmail || 'admin@example.com';

    const provisionPayload = {
      name: request.name,
      domain: derivedDomain,
      version: request.version,
      node: request.node,
      vmid,
      hostname: request.name,
      email,
      resources: request.resources,
      database: {
        name: request.database.name,
        user: request.database.user,
        password: request.database.password,
      },
      adminPassword: request.adminPassword,
      newDbAccount: request.newDbAccount,
    };

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startProvisionJob(
        baseUrl,
        provisionPayload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);

      // Poll for status + new log lines.
      let lastLineCount = 0;
      // Safety cap so a stuck job doesn't poll forever in the browser.
      const deadline = Date.now() + 60 * 60 * 1000; // 1 hour
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
        // Append newly arrived log lines.
        if (job.lines.length > lastLineCount) {
          for (let i = lastLineCount; i < job.lines.length; i++) {
            const line = job.lines[i];
            appendProvisionLog(line);
            for (const m of STEP_MARKERS) {
              if (m.pattern.test(line)) advanceSteps(m.advanceTo);
            }
          }
          lastLineCount = job.lines.length;
        }
        if (job.status === 'running' || job.status === 'queued') {
          // Make sure at least `connect` is marked done once we see output.
          if (job.lines.length > 0) advanceSteps('container');
          continue;
        }
        if (job.status === 'success') {
          setProvisionSteps(prev =>
            prev.map(s =>
              s.status === 'error' ? s : { ...s, status: 'done' },
            ),
          );
          setProvisionDone(true);
          appendProvisionLog(
            `Instance "${request.name}" provisioned successfully (exit 0).`,
          );
          loadInstances();
          break;
        }
        // status === 'failed'
        const message =
          job.error ?? `Provisioning failed (exit ${job.exitCode ?? '?'})`;
        setProvisionSteps(prev =>
          prev.map(s =>
            s.status === 'running'
              ? { ...s, status: 'error', detail: message }
              : s,
          ),
        );
        setProvisionError(message);
        appendProvisionLog(`ERROR: ${message}`);
        break;
      }
    } catch (error) {
      console.error('Failed to create instance:', error);
      const message =
        error instanceof Error ? error.message : String(error);
      setProvisionSteps(prev =>
        prev.map(s =>
          s.status === 'running'
            ? { ...s, status: 'error', detail: message }
            : s,
        ),
      );
      setProvisionError(message);
      appendProvisionLog(`ERROR: ${message}`);
    }
  };

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
    try {
      await dhis2Service.deleteInstance(id);
      loadInstances();
    } catch (error) {
      console.error('Failed to delete instance:', error);
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
            <Tab label="Proxmox Cluster" />
            <Tab label="Instances" />
            <Tab label="Proxy" />
            <Tab label="Logs" />
          </Tabs>
        </Paper>

        {/* Tab panels */}
        <Paper>
          {/* Instances Tab */}
          <TabPanel value={tabValue} index={1}>
            <DHIS2InstancesPanel
              instances={instances}
              loading={loading}
              onCreateInstance={() => setCreateDialogOpen(true)}
              onStart={handleStartInstance}
              onStop={handleStopInstance}
              onRestart={handleRestartInstance}
              onViewLogs={handleViewInstanceLogs}
              onRestore={instance => setRestoreDialog({ open: true, instance })}
              onDelete={handleDeleteInstance}
              onChanged={loadInstances}
            />
          </TabPanel>

          {/* Proxmox Cluster Tab */}
          <TabPanel value={tabValue} index={0}>
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
            <ProxmoxClusterPanel
              instances={instances}
              onNodesChange={setNodes}
            />
          </TabPanel>

          {/* Proxy Tab */}
          <TabPanel value={tabValue} index={2}>
            <DHIS2ProxyPanel
              instances={instances}
              loading={loading}
              onViewLogs={handleViewInstanceLogs}
            />
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

        {/* Create Instance Dialog (extracted to CreateInstanceDialog.tsx) */}
        <CreateInstanceDialog
          open={createDialogOpen}
          onClose={() => setCreateDialogOpen(false)}
          nodes={nodes}
          versions={versions}
          onSubmit={handleCreateInstance}
        />

        {/* Provisioning progress dialog — gives the user step-by-step
            visibility into the multi-stage Create Instance workflow. */}
        <Dialog
          open={provisionOpen}
          onClose={() => {
            if (provisionDone || provisionError) setProvisionOpen(false);
          }}
          maxWidth="sm"
          fullWidth
          disableBackdropClick={!provisionDone && !provisionError}
          disableEscapeKeyDown={!provisionDone && !provisionError}
        >
          <DialogTitle>
            {provisionDone
              ? `Instance "${provisionInstanceName}" created`
              : provisionError
              ? `Failed to create "${provisionInstanceName}"`
              : `Creating instance "${provisionInstanceName}"`}
          </DialogTitle>
          <DialogContent dividers>
            {!provisionDone && !provisionError && (
              <Box mb={2}>
                <Typography variant="body2" color="textSecondary">
                  Provisioning is in progress. Please keep this dialog open
                  until it completes.
                </Typography>
              </Box>
            )}
            {provisionError && (
              <Box mb={2}>
                <Alert severity="error">{provisionError}</Alert>
              </Box>
            )}
            {provisionDone && (
              <Box mb={2}>
                <Alert severity="success">
                  Instance provisioned successfully.
                </Alert>
              </Box>
            )}
            <Box>
              {provisionSteps.map(step => {
                let icon: React.ReactNode;
                if (step.status === 'done') {
                  icon = (
                    <CheckCircleIcon
                      style={{ color: '#2e7d32' }}
                      fontSize="small"
                    />
                  );
                } else if (step.status === 'error') {
                  icon = (
                    <ErrorOutlineIcon color="error" fontSize="small" />
                  );
                } else if (step.status === 'running') {
                  icon = <CircularProgress size={18} />;
                } else {
                  icon = (
                    <RadioButtonUncheckedIcon
                      htmlColor="#9e9e9e"
                      fontSize="small"
                    />
                  );
                }
                return (
                  <Box
                    key={step.key}
                    display="flex"
                    alignItems="flex-start"
                    style={{ padding: '6px 0', gap: 12 }}
                  >
                    <Box
                      style={{
                        width: 24,
                        display: 'flex',
                        justifyContent: 'center',
                        marginTop: 2,
                      }}
                    >
                      {icon}
                    </Box>
                    <Box flexGrow={1}>
                      <Typography
                        variant="body2"
                        style={{
                          fontWeight:
                            step.status === 'running' ? 600 : 400,
                          color:
                            step.status === 'pending'
                              ? '#9e9e9e'
                              : undefined,
                        }}
                      >
                        {step.label}
                      </Typography>
                      {step.detail && (
                        <Typography
                          variant="caption"
                          color={
                            step.status === 'error'
                              ? 'error'
                              : 'textSecondary'
                          }
                        >
                          {step.detail}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              })}
            </Box>
            {provisionLog.length > 0 && (
              <Box mt={2}>
                <Typography variant="caption" color="textSecondary">
                  Activity log
                </Typography>
                <Paper
                  variant="outlined"
                  style={{
                    maxHeight: 160,
                    overflowY: 'auto',
                    padding: 8,
                    marginTop: 4,
                    background: '#0e1116',
                    color: '#d0d7de',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                  }}
                >
                  {provisionLog.map((line, idx) => (
                    <div key={idx}>{line}</div>
                  ))}
                </Paper>
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setProvisionOpen(false)}
              disabled={!provisionDone && !provisionError}
              color="primary"
              variant="contained"
            >
              {provisionDone || provisionError ? 'Close' : 'Working…'}
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
