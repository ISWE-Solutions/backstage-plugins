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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
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
import { DHIS2Instance, CreateInstanceRequest, ProxmoxNode } from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { DHIS2SettingsPage } from './DHIS2SettingsPage';
import { DHIS2LogsPanel } from './DHIS2LogsPanel';
import { ProxmoxClusterPanel } from './ProxmoxClusterPanel';

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

  const [newInstance, setNewInstance] = useState<CreateInstanceRequest>({
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
      await dhis2Service.createInstance(newInstance);
      setCreateDialogOpen(false);
      loadInstances();
      // Reset form
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
      });
    } catch (error) {
      console.error('Failed to create instance:', error);
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
  const totalCPU = instances.reduce((sum, i) => sum + i.resources.cpu, 0);
  const totalMemory = instances.reduce((sum, i) => sum + i.resources.memory, 0);

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
          <IconButton onClick={loadInstances} color="primary">
            <RefreshIcon />
          </IconButton>
        </ContentHeader>

        {/* Tabs */}
        <Paper style={{ marginBottom: 24 }}>
          <Tabs value={tabValue} onChange={(_e, newValue) => setTabValue(newValue)} indicatorColor="primary">
            <Tab label="Instances" />
            <Tab label="Proxmox Cluster" />
            <Tab label="Nginx Configuration" />
            <Tab label="Logs" />
            <Tab label="Settings" />
          </Tabs>
        </Paper>

        {/* Statistics */}
        <Grid container spacing={3} style={{ marginBottom: 24 }}>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.statCard}>
              <StorageIcon style={{ fontSize: '3rem', color: '#1976d2' }} />
              <Typography className={classes.statValue}>{instances.length}</Typography>
              <Typography variant="h6" color="textSecondary">
                Total Instances
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.statCard}>
              <PlayArrowIcon style={{ fontSize: '3rem', color: '#4caf50' }} />
              <Typography className={classes.statValue}>{runningInstances}</Typography>
              <Typography variant="h6" color="textSecondary">
                Running
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.statCard}>
              <CloudIcon style={{ fontSize: '3rem', color: '#ff9800' }} />
              <Typography className={classes.statValue}>{totalCPU}</Typography>
              <Typography variant="h6" color="textSecondary">
                Total vCPUs
              </Typography>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card className={classes.statCard}>
              <DnsIcon style={{ fontSize: '3rem', color: '#9c27b0' }} />
              <Typography className={classes.statValue}>{(totalMemory / 1024).toFixed(0)} GB</Typography>
              <Typography variant="h6" color="textSecondary">
                Total Memory
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

          {/* Nginx Configuration Tab */}
          <TabPanel value={tabValue} index={2}>
            <Typography variant="h6" gutterBottom>
              Shared Nginx Reverse Proxy
            </Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              All DHIS2 instances share a centralized Nginx proxy server that handles SSL termination,
              load balancing, and routing based on domain names.
            </Typography>
            <TableContainer component={Paper} variant="outlined">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Domain</TableCell>
                    <TableCell>Instance</TableCell>
                    <TableCell>Backend</TableCell>
                    <TableCell>SSL Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {instances.map(instance => (
                    <TableRow key={instance.id}>
                      <TableCell>{instance.domain}</TableCell>
                      <TableCell>{instance.name}</TableCell>
                      <TableCell>Container {instance.vmid}:8080</TableCell>
                      <TableCell>
                        <Chip label="Active" color="primary" size="small" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>

          {/* Logs Tab */}
          <TabPanel value={tabValue} index={3}>
            <DHIS2LogsPanel />
          </TabPanel>

          {/* Settings Tab */}
          <TabPanel value={tabValue} index={4}>
            <DHIS2SettingsPage />
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
            <TextField
              fullWidth
              label="Instance Name"
              value={newInstance.name}
              onChange={e => setNewInstance({ ...newInstance, name: e.target.value })}
              className={classes.formField}
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
            <Typography variant="h6" gutterBottom style={{ marginTop: 16 }}>
              Database Configuration
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
              label="Database User"
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
              type="password"
              label="Database Password"
              value={newInstance.database.password}
              onChange={e => setNewInstance({
                ...newInstance,
                database: { ...newInstance.database, password: e.target.value },
              })}
              className={classes.formField}
              required
            />
            <TextField
              fullWidth
              type="password"
              label="DHIS2 Admin Password"
              value={newInstance.adminPassword}
              onChange={e => setNewInstance({ ...newInstance, adminPassword: e.target.value })}
              className={classes.formField}
              helperText="Password for the DHIS2 admin user"
              required
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateInstance} color="primary" variant="contained">
              Create Instance
            </Button>
          </DialogActions>
        </Dialog>
      </Content>
    </Page>
  );
};
