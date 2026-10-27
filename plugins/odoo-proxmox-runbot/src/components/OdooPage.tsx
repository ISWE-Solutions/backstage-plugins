import React, { useState, useEffect, useRef } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tab,
  CircularProgress,
  LinearProgress,
  makeStyles,
  Tooltip,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
} from '@material-ui/core';
import {
  Header,
  Page,
  Content,
  ContentHeader,
  SupportButton,
} from '@backstage/core-components';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import RefreshIcon from '@material-ui/icons/Refresh';
import SettingsIcon from '@material-ui/icons/Settings';
import CloudIcon from '@material-ui/icons/Cloud';
import DnsIcon from '@material-ui/icons/Dns';
import BuildIcon from '@material-ui/icons/Build';
import AssessmentIcon from '@material-ui/icons/Assessment';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import WarningIcon from '@material-ui/icons/Warning';
import ScheduleIcon from '@material-ui/icons/Schedule';
import {
  OdooInstance,
  CreateOdooInstanceRequest,
  RunbotBuild,
  RunbotBranch,
  AnsiblePlaybook,
  AnsiblePlaybookExecution,
  ProxmoxNode,
  OdooDashboardStats,
  PostgresCluster,
} from '../types';
import { odooService } from '../services/odooService';
import { runbotService } from '../services/runbotService';
import { ansibleService } from '../services/ansibleService';
import { proxmoxService } from '../services/proxmoxService';
import { OdooInstancesPanel } from './OdooInstancesPanel';
import { OdooRunbotPanel } from './OdooRunbotPanel';
import { OdooAnsiblePanel } from './OdooAnsiblePanel';
import { OdooProxmoxClusterPanel } from './OdooProxmoxClusterPanel';
import { CreateInstanceDialog } from './CreateInstanceDialog';

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
    textAlign: 'center',
    padding: theme.spacing(3),
  },
  statValue: {
    fontSize: '2.5rem',
    fontWeight: 'bold',
    color: theme.palette.primary.main,
  },
  statLabel: {
    fontSize: '0.875rem',
    color: theme.palette.text.secondary,
    marginTop: theme.spacing(1),
  },
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  runningChip: {
    backgroundColor: theme.palette.success.main,
    color: theme.palette.success.contrastText,
  },
  stoppedChip: {
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
  },
  provisioningChip: {
    backgroundColor: theme.palette.warning.main,
    color: theme.palette.warning.contrastText,
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
  buildOk: {
    color: theme.palette.success.main,
  },
  buildKo: {
    color: theme.palette.error.main,
  },
  buildWarn: {
    color: theme.palette.warning.main,
  },
  buildPending: {
    color: theme.palette.info.main,
  },
  progressBar: {
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(1),
  },
  nodeCard: {
    marginBottom: theme.spacing(2),
  },
  sectionTitle: {
    marginBottom: theme.spacing(2),
  },
  tabPanel: {
    paddingTop: theme.spacing(2),
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

export const OdooPage = () => {
  const classes = useStyles();
  const [loading, setLoading] = useState(true);
  const [tabValue, setTabValue] = useState(0);

  // Data state
  const [instances, setInstances] = useState<OdooInstance[]>([]);
  const [builds, setBuilds] = useState<RunbotBuild[]>([]);
  const [branches, setBranches] = useState<RunbotBranch[]>([]);
  const [playbooks, setPlaybooks] = useState<AnsiblePlaybook[]>([]);
  const [executions, setExecutions] = useState<AnsiblePlaybookExecution[]>([]);
  const [nodes, setNodes] = useState<ProxmoxNode[]>([]);
  const [stats, setStats] = useState<OdooDashboardStats | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [clusters, setClusters] = useState<PostgresCluster[]>([]);

  // Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [playbookDialogOpen, setPlaybookDialogOpen] = useState(false);
  const [selectedPlaybook, setSelectedPlaybook] =
    useState<AnsiblePlaybook | null>(null);

  // Guards against overlapping loadAllData() calls (e.g. rapid Refresh
  // clicks) and against setState firing after the component unmounts.
  const isLoadingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadAllData(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const loadAllData = async (isCancelled: () => boolean = () => false) => {
    if (isLoadingRef.current) {
      return;
    }
    isLoadingRef.current = true;
    setLoading(true);
    try {
      const [
        instancesData,
        buildsData,
        branchesData,
        playbooksData,
        executionsData,
        nodesData,
        statsData,
        versionsData,
        clustersData,
      ] = await Promise.all([
        odooService.getInstances(),
        runbotService.getBuilds(),
        runbotService.getBranches(),
        ansibleService.getPlaybooks(),
        ansibleService.getExecutions(),
        proxmoxService.getNodes(),
        odooService.getDashboardStats(),
        odooService.getAvailableVersions(),
        odooService.getDatabaseClusters(),
      ]);

      if (isCancelled()) {
        return;
      }

      setInstances(instancesData);
      setBuilds(buildsData);
      setBranches(branchesData);
      setPlaybooks(playbooksData);
      setExecutions(executionsData);
      setNodes(nodesData);
      setStats(statsData);
      setVersions(versionsData);
      setClusters(clustersData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      isLoadingRef.current = false;
      if (!isCancelled()) {
        setLoading(false);
      }
    }
  };

  // Errors propagate to the dialog, which shows them
  const handleCreateInstance = async (request: CreateOdooInstanceRequest) => {
    await odooService.createInstance(request);
    loadAllData();
  };

  const handleStartInstance = async (id: string) => {
    try {
      await odooService.startInstance(id);
      loadAllData();
    } catch (error) {
      console.error('Failed to start instance:', error);
    }
  };

  const handleStopInstance = async (id: string) => {
    try {
      await odooService.stopInstance(id);
      loadAllData();
    } catch (error) {
      console.error('Failed to stop instance:', error);
    }
  };

  const handleDeleteInstance = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this instance?')) {
      try {
        await odooService.deleteInstance(id);
        loadAllData();
      } catch (error) {
        console.error('Failed to delete instance:', error);
      }
    }
  };

  const handleTriggerBuild = async (branchId: number) => {
    try {
      await runbotService.triggerBuild(branchId);
      loadAllData();
    } catch (error) {
      console.error('Failed to trigger build:', error);
    }
  };

  const handleKillBuild = async (buildId: number) => {
    try {
      await runbotService.killBuild(buildId);
      loadAllData();
    } catch (error) {
      console.error('Failed to kill build:', error);
    }
  };

  const handleExecutePlaybook = async (playbook: AnsiblePlaybook) => {
    setSelectedPlaybook(playbook);
    setPlaybookDialogOpen(true);
  };

  const handleRunPlaybook = async () => {
    if (selectedPlaybook) {
      try {
        await ansibleService.executePlaybook(
          selectedPlaybook.id,
          ['target-host'],
          selectedPlaybook.variables,
        );
        setSelectedPlaybook(null);
        loadAllData();
      } catch (error) {
        console.error('Failed to run playbook:', error);
      } finally {
        setPlaybookDialogOpen(false);
      }
    }
  };

  const getStatusChip = (status: string) => {
    switch (status) {
      case 'running':
        return (
          <Chip label="Running" size="small" className={classes.runningChip} />
        );
      case 'stopped':
        return (
          <Chip label="Stopped" size="small" className={classes.stoppedChip} />
        );
      case 'provisioning':
        return (
          <Chip
            label="Provisioning"
            size="small"
            className={classes.provisioningChip}
          />
        );
      default:
        return <Chip label={status} size="small" />;
    }
  };

  const getBuildResultIcon = (result: string, state: string) => {
    if (state === 'pending')
      return <ScheduleIcon className={classes.buildPending} />;
    if (state === 'testing' || state === 'running')
      return <CircularProgress size={20} />;
    switch (result) {
      case 'ok':
        return <CheckCircleIcon className={classes.buildOk} />;
      case 'ko':
        return <ErrorIcon className={classes.buildKo} />;
      case 'warn':
        return <WarningIcon className={classes.buildWarn} />;
      default:
        return <ScheduleIcon className={classes.buildPending} />;
    }
  };

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  // Dashboard Tab
  const renderDashboard = () => (
    <Grid container spacing={3}>
      {/* Stats Cards */}
      <Grid item xs={12} sm={6} md={3}>
        <Card className={classes.statCard}>
          <CardContent>
            <CloudIcon color="primary" style={{ fontSize: 40 }} />
            <Typography className={classes.statValue}>
              {stats?.totalInstances || 0}
            </Typography>
            <Typography className={classes.statLabel}>
              Total Instances
            </Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <Card className={classes.statCard}>
          <CardContent>
            <CheckCircleIcon style={{ fontSize: 40, color: '#4caf50' }} />
            <Typography className={classes.statValue}>
              {stats?.runningInstances || 0}
            </Typography>
            <Typography className={classes.statLabel}>Running</Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <Card className={classes.statCard}>
          <CardContent>
            <BuildIcon color="primary" style={{ fontSize: 40 }} />
            <Typography className={classes.statValue}>
              {stats?.totalBuilds || 0}
            </Typography>
            <Typography className={classes.statLabel}>Total Builds</Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <Card className={classes.statCard}>
          <CardContent>
            <DnsIcon color="primary" style={{ fontSize: 40 }} />
            <Typography className={classes.statValue}>
              {stats?.nodeCount || 0}
            </Typography>
            <Typography className={classes.statLabel}>Proxmox Nodes</Typography>
          </CardContent>
        </Card>
      </Grid>

      {/* Resource Usage */}
      <Grid item xs={12} md={6}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Cluster Resources
            </Typography>
            <Box mb={2}>
              <Typography variant="body2">CPU Usage</Typography>
              <LinearProgress
                variant="determinate"
                value={((stats?.usedCpu || 0) / (stats?.totalCpu || 1)) * 100}
                className={classes.progressBar}
              />
              <Typography variant="caption">
                {stats?.usedCpu?.toFixed(1) || 0} / {stats?.totalCpu || 0} cores
              </Typography>
            </Box>
            <Box mb={2}>
              <Typography variant="body2">Memory Usage</Typography>
              <LinearProgress
                variant="determinate"
                value={
                  ((stats?.usedMemory || 0) / (stats?.totalMemory || 1)) * 100
                }
                className={classes.progressBar}
              />
              <Typography variant="caption">
                {formatBytes(stats?.usedMemory || 0)} /{' '}
                {formatBytes(stats?.totalMemory || 0)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2">Storage Usage</Typography>
              <LinearProgress
                variant="determinate"
                value={
                  ((stats?.usedStorage || 0) / (stats?.totalStorage || 1)) * 100
                }
                className={classes.progressBar}
              />
              <Typography variant="caption">
                {formatBytes(stats?.usedStorage || 0)} /{' '}
                {formatBytes(stats?.totalStorage || 0)}
              </Typography>
            </Box>
          </CardContent>
        </Card>
      </Grid>

      {/* Recent Builds */}
      <Grid item xs={12} md={6}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Recent Runbot Builds
            </Typography>
            <List dense>
              {builds.slice(0, 5).map(build => (
                <ListItem key={build.id}>
                  <ListItemIcon>
                    {getBuildResultIcon(build.result, build.state)}
                  </ListItemIcon>
                  <ListItemText
                    primary={`${build.repo_name}/${build.branch_name}`}
                    secondary={build.commit_message.substring(0, 50)}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      </Grid>

      {/* Active Instances */}
      <Grid item xs={12}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Odoo Instances
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Version</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Node</TableCell>
                    <TableCell>URL</TableCell>
                    <TableCell>Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {instances.map(instance => (
                    <TableRow key={instance.id}>
                      <TableCell>{instance.name}</TableCell>
                      <TableCell>
                        {instance.version} ({instance.edition})
                      </TableCell>
                      <TableCell>{getStatusChip(instance.status)}</TableCell>
                      <TableCell>{instance.node}</TableCell>
                      <TableCell>
                        <a
                          href={instance.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {instance.domain}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Tooltip title="Open">
                          <IconButton
                            size="small"
                            onClick={() => window.open(instance.url, '_blank')}
                          >
                            <CloudIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );

  // Instances Tab
  const renderInstances = () => (
    <OdooInstancesPanel
      instances={instances}
      onCreateInstance={() => setCreateDialogOpen(true)}
      onStartInstance={handleStartInstance}
      onStopInstance={handleStopInstance}
      onDeleteInstance={handleDeleteInstance}
      onBackupInstance={id => odooService.backupInstance(id)}
    />
  );

  // Runbot Tab
  const renderRunbot = () => (
    <OdooRunbotPanel
      branches={branches}
      builds={builds}
      onTriggerBuild={handleTriggerBuild}
      onKillBuild={handleKillBuild}
      onRebuildBuild={id => runbotService.rebuildBuild(id)}
    />
  );

  // Ansible Tab
  const renderAnsible = () => (
    <OdooAnsiblePanel
      playbooks={playbooks}
      executions={executions}
      onExecutePlaybook={handleExecutePlaybook}
    />
  );

  // Proxmox Tab
  const renderProxmox = () => <OdooProxmoxClusterPanel nodes={nodes} />;

  if (loading) {
    return (
      <Page themeId="tool">
        <Header
          title="Odoo Management"
          subtitle="Runbot & Container Orchestration"
        />
        <Content>
          <Box
            display="flex"
            justifyContent="center"
            alignItems="center"
            minHeight={400}
          >
            <CircularProgress />
          </Box>
        </Content>
      </Page>
    );
  }

  return (
    <Page themeId="tool">
      <Header
        title="Odoo Management"
        subtitle="Runbot & Proxmox Container Orchestration"
      >
        <Button
          variant="contained"
          color="primary"
          startIcon={<RefreshIcon />}
          onClick={() => loadAllData()}
          disabled={loading}
        >
          Refresh
        </Button>
      </Header>
      <Content>
        <ContentHeader title="">
          <SupportButton>
            Manage Odoo instances, Runbot CI/CD, and Ansible deployments
          </SupportButton>
        </ContentHeader>

        <Tabs
          value={tabValue}
          onChange={(_, newValue) => setTabValue(newValue)}
          indicatorColor="primary"
          textColor="primary"
        >
          <Tab label="Dashboard" icon={<AssessmentIcon />} />
          <Tab label="Instances" icon={<CloudIcon />} />
          <Tab label="Runbot" icon={<BuildIcon />} />
          <Tab label="Ansible" icon={<SettingsIcon />} />
          <Tab label="Proxmox" icon={<DnsIcon />} />
        </Tabs>

        <TabPanel value={tabValue} index={0}>
          {renderDashboard()}
        </TabPanel>
        <TabPanel value={tabValue} index={1}>
          {renderInstances()}
        </TabPanel>
        <TabPanel value={tabValue} index={2}>
          {renderRunbot()}
        </TabPanel>
        <TabPanel value={tabValue} index={3}>
          {renderAnsible()}
        </TabPanel>
        <TabPanel value={tabValue} index={4}>
          {renderProxmox()}
        </TabPanel>

        <CreateInstanceDialog
          open={createDialogOpen}
          onClose={() => setCreateDialogOpen(false)}
          onCreate={handleCreateInstance}
          nodes={nodes}
          versions={versions}
          clusters={clusters}
        />

        {/* Playbook Execution Dialog */}
        <Dialog
          open={playbookDialogOpen}
          onClose={() => setPlaybookDialogOpen(false)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Run Playbook: {selectedPlaybook?.name}</DialogTitle>
          <DialogContent>
            <Typography variant="body2" gutterBottom>
              {selectedPlaybook?.description}
            </Typography>
            <Typography variant="subtitle2" style={{ marginTop: 16 }}>
              Variables:
            </Typography>
            {selectedPlaybook &&
              Object.entries(selectedPlaybook.variables).map(([key, value]) => (
                <TextField
                  key={key}
                  fullWidth
                  label={key}
                  defaultValue={String(value)}
                  className={classes.formField}
                  size="small"
                />
              ))}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPlaybookDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleRunPlaybook}
              color="primary"
              variant="contained"
              startIcon={<PlayArrowIcon />}
            >
              Run Playbook
            </Button>
          </DialogActions>
        </Dialog>
      </Content>
    </Page>
  );
};

export default OdooPage;
