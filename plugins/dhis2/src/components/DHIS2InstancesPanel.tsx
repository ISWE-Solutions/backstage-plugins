import { useEffect, useMemo, useState } from 'react';

import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Button,
  ButtonGroup,
  Chip,
  IconButton,
  CircularProgress,
  Checkbox,
  TextField,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Tooltip,
  makeStyles,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import AddIcon from '@material-ui/icons/Add';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import RefreshIcon from '@material-ui/icons/Refresh';
import DeleteIcon from '@material-ui/icons/Delete';
import SettingsIcon from '@material-ui/icons/Settings';
import DescriptionIcon from '@material-ui/icons/Description';
import SettingsBackupRestoreIcon from '@material-ui/icons/SettingsBackupRestore';
import BackupIcon from '@material-ui/icons/Backup';
import SwapHorizIcon from '@material-ui/icons/SwapHoriz';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { DHIS2Instance } from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { TransferDatabaseDialog } from './TransferDatabaseDialog';

const useStyles = makeStyles(theme => ({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  },
  filterField: {
    minWidth: 180,
  },
  statusChip: {
    marginLeft: theme.spacing(1),
  },
  actionButtons: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginTop: theme.spacing(2),
  },
  instanceCard: {
    marginBottom: theme.spacing(2),
    borderLeft: `4px solid ${theme.palette.primary.main}`,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: theme.spacing(2),
  },
  cardSelect: {
    marginLeft: -theme.spacing(1),
  },
}));

export const getInstanceStatusColor = (
  status: string,
): 'default' | 'primary' | 'secondary' => {
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

export interface DHIS2InstancesPanelProps {
  instances: DHIS2Instance[];
  loading: boolean;
  onCreateInstance: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onViewLogs: (instance: DHIS2Instance) => void;
  onRestore: (instance: DHIS2Instance) => void;
  onDelete: (id: string) => void;
  /**
   * Called after the panel mutates an instance (edit, backup, refresh) so
   * the parent can re-load its instance list.
   */
  onChanged?: () => void;
  /**
   * Containers in the Proxmox cluster that carry the `dhis2` tag but
   * are NOT in the backend's instance registry. Surfaced as a banner so
   * the operator can adopt or investigate them.
   */
  unmanagedContainers?: Array<{
    vmid: number;
    node: string;
    name?: string;
    tags?: string;
    status?: string;
  }>;
  /**
   * Optional message describing why reconciliation could not be performed
   * (e.g. Proxmox API not configured). Shown as an info banner.
   */
  reconcileWarning?: string | null;
  /**
   * Names of Proxmox cluster nodes used to populate the node filter.
   * When provided, this list is used verbatim instead of deriving the
   * filter options from the instance list — so empty nodes still appear.
   */
  clusterNodes?: string[];
}

type Severity = 'success' | 'error' | 'info';

interface EditDraft {
  name: string;
  version: string;
  cpu: number;
  memoryMb: number;
  storageGb: number;
  dbName: string;
  dbUser: string;
  dbHost: string;
  dbPort: number;
  dbPassword: string;
}

const DEFAULT_PG_PORT = 5432;

/**
 * Map a `driftStatus` from the backend reconciler into a small chip
 * descriptor. `managed` (healthy) and `unknown` (no Proxmox API) are
 * deliberately not rendered to avoid noise on the cards.
 */
const driftChipFor = (
  status: DHIS2Instance['driftStatus'],
):
  | { label: string; tooltip: string; color: 'default' | 'secondary' }
  | null => {
  switch (status) {
    case 'missing':
      return {
        label: 'Missing on Proxmox',
        tooltip:
          'This instance is registered with Backstage but the underlying LXC no longer exists on the Proxmox cluster. Investigate or delete the registry entry.',
        color: 'secondary',
      };
    case 'untagged':
      return {
        label: 'Untagged',
        tooltip:
          'The LXC exists but is missing the `dhis2` tag in Proxmox. The reconciler may stop recognising it as managed by this plugin. Re-apply the tag in the PVE UI.',
        color: 'default',
      };
    default:
      return null;
  }
};

const formatRelative = (iso?: string): string => {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
};

export const DHIS2InstancesPanel = ({
  instances,
  loading,
  onCreateInstance,
  onStart,
  onStop,
  onRestart,
  onViewLogs,
  onRestore,
  onDelete,
  onChanged,
  unmanagedContainers = [],
  reconcileWarning = null,
  clusterNodes,
}: DHIS2InstancesPanelProps) => {
  const classes = useStyles();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [nodeFilter, setNodeFilter] = useState<string>('all');

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [localBackups, setLocalBackups] = useState<Record<string, string>>({});

  const [editTarget, setEditTarget] = useState<DHIS2Instance | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [versions, setVersions] = useState<string[]>([]);

  const [transferTarget, setTransferTarget] = useState<DHIS2Instance | null>(
    null,
  );

  const [confirm, setConfirm] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [toast, setToast] = useState<{
    open: boolean;
    severity: Severity;
    message: string;
  }>({ open: false, severity: 'info', message: '' });

  const notify = (severity: Severity, message: string) =>
    setToast({ open: true, severity, message });

  const setBusyKey = (key: string, on: boolean) =>
    setBusy(prev => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const runAction = async (
    key: string,
    label: string,
    fn: () => Promise<void>,
  ) => {
    setBusyKey(key, true);
    try {
      await fn();
      notify('success', `${label} completed`);
    } catch (e: any) {
      notify('error', `${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusyKey(key, false);
    }
  };

  useEffect(() => {
    if (editTarget && versions.length === 0) {
      dhis2Service.getVersions().then(setVersions).catch(() => {});
    }
  }, [editTarget, versions.length]);

  // Node filter options. Prefer the live list of Proxmox cluster nodes
  // passed in by the parent so the dropdown reflects the cluster even
  // when no instances exist yet on a given node; fall back to nodes
  // derived from the instance list when the cluster list is unavailable.
  const nodes = useMemo(() => {
    if (clusterNodes && clusterNodes.length > 0) {
      return Array.from(new Set(clusterNodes)).sort();
    }
    return Array.from(new Set(instances.map(i => i.node))).sort();
  }, [clusterNodes, instances]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return instances.filter(i => {
      if (statusFilter !== 'all' && i.status !== statusFilter) return false;
      if (nodeFilter !== 'all' && i.node !== nodeFilter) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.domain.toLowerCase().includes(q) ||
        i.vmid.toLowerCase().includes(q) ||
        i.database.name.toLowerCase().includes(q)
      );
    });
  }, [instances, search, statusFilter, nodeFilter]);

  const selectedInstances = filtered.filter(i => selected.has(i.id));

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allFilteredSelected =
    filtered.length > 0 && filtered.every(i => selected.has(i.id));

  const toggleSelectAll = () =>
    setSelected(prev => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filtered.forEach(i => next.delete(i.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach(i => next.add(i.id));
      return next;
    });

  const confirmThen = (title: string, message: string, fn: () => void) =>
    setConfirm({ open: true, title, message, onConfirm: fn });

  const handleStop = (instance: DHIS2Instance) =>
    confirmThen(
      'Stop instance',
      `Stop "${instance.name}"? Active users will be disconnected.`,
      () => onStop(instance.id),
    );

  const handleRestart = (instance: DHIS2Instance) =>
    confirmThen(
      'Restart instance',
      `Restart "${instance.name}"? The instance will be unavailable for ~30s.`,
      () => onRestart(instance.id),
    );

  const handleDelete = (instance: DHIS2Instance) =>
    confirmThen(
      'Delete instance',
      `Permanently delete "${instance.name}"? This removes the container, nginx config and database.`,
      () => onDelete(instance.id),
    );

  const handleRefreshOne = (instance: DHIS2Instance) =>
    runAction(`refresh:${instance.id}`, `Refresh ${instance.name}`, async () => {
      await dhis2Service.refreshInstance(instance.id);
      onChanged?.();
    });

  const handleBackup = (instance: DHIS2Instance) =>
    runAction(`backup:${instance.id}`, `Backup ${instance.name}`, async () => {
      const res = await dhis2Service.backupInstance(instance.id);
      setLocalBackups(prev => ({ ...prev, [instance.id]: res.timestamp }));
      onChanged?.();
    });

  const handleOpenEdit = (instance: DHIS2Instance) => {
    setEditTarget(instance);
    setEditDraft({
      name: instance.name,
      version: instance.version,
      cpu: instance.resources.cpu,
      memoryMb: instance.resources.memory,
      storageGb: instance.resources.storage,
      dbName: instance.database.name,
      dbUser: instance.database.user,
      dbHost: instance.database.host ?? '',
      dbPort: instance.database.port ?? DEFAULT_PG_PORT,
      dbPassword: instance.database.password ?? '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editDraft) return;
    const target = editTarget;
    const draft = editDraft;
    setEditTarget(null);
    setEditDraft(null);
    await runAction(`edit:${target.id}`, `Update ${target.name}`, async () => {
      await dhis2Service.updateInstance(target.id, {
        name: draft.name,
        version: draft.version,
        resources: {
          cpu: draft.cpu,
          memory: draft.memoryMb,
          storage: draft.storageGb,
        },
        database: {
          name: draft.dbName,
          user: draft.dbUser,
          host: draft.dbHost,
          port: draft.dbPort,
          password: draft.dbPassword,
        },
      });
      onChanged?.();
    });
  };

  const bulkStart = () =>
    selectedInstances
      .filter(i => i.status === 'stopped')
      .forEach(i => onStart(i.id));

  const bulkStop = () =>
    confirmThen(
      'Stop selected',
      `Stop ${selectedInstances.length} instance(s)?`,
      () =>
        selectedInstances
          .filter(i => i.status === 'running')
          .forEach(i => onStop(i.id)),
    );

  const bulkBackup = () => selectedInstances.forEach(i => handleBackup(i));

  const renderToolbar = () => (
    <Box className={classes.toolbar}>
      <TextField
        className={classes.filterField}
        label="Search"
        size="small"
        variant="outlined"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="name, domain, VMID, db"
      />
      <TextField
        className={classes.filterField}
        select
        label="Status"
        size="small"
        variant="outlined"
        value={statusFilter}
        onChange={e => setStatusFilter(e.target.value)}
      >
        <MenuItem value="all">All statuses</MenuItem>
        <MenuItem value="running">Running</MenuItem>
        <MenuItem value="stopped">Stopped</MenuItem>
        <MenuItem value="provisioning">Provisioning</MenuItem>
        <MenuItem value="error">Error</MenuItem>
      </TextField>
      <TextField
        className={classes.filterField}
        select
        label="Node"
        size="small"
        variant="outlined"
        value={nodeFilter}
        onChange={e => setNodeFilter(e.target.value)}
      >
        <MenuItem value="all">All nodes</MenuItem>
        {nodes.map(n => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      <Box flexGrow={1} />
      <Typography variant="body2" color="textSecondary">
        {filtered.length} of {instances.length} shown · {selected.size} selected
      </Typography>
      <ButtonGroup
        size="small"
        variant="outlined"
        disabled={selected.size === 0}
      >
        <Button startIcon={<PlayArrowIcon />} onClick={bulkStart}>
          Start
        </Button>
        <Button startIcon={<StopIcon />} onClick={bulkStop}>
          Stop
        </Button>
        <Button startIcon={<BackupIcon />} onClick={bulkBackup}>
          Backup
        </Button>
      </ButtonGroup>
      <Button
        variant="outlined"
        size="small"
        onClick={toggleSelectAll}
        disabled={filtered.length === 0}
      >
        {allFilteredSelected ? 'Clear selection' : 'Select all'}
      </Button>
      <Button
        variant="contained"
        color="primary"
        size="small"
        startIcon={<AddIcon />}
        onClick={onCreateInstance}
      >
        Create Instance
      </Button>
    </Box>
  );

  const renderInstanceCard = (instance: DHIS2Instance) => {
    const isBusy = (action: string) => busy.has(`${action}:${instance.id}`);
    const lastBackup = instance.lastBackup ?? localBackups[instance.id];
    return (
      <Grid item xs={12} key={instance.id}>
        <Card className={classes.instanceCard}>
          <CardContent>
            <Box className={classes.cardHeader}>
              <Box display="flex" alignItems="flex-start">
                <Checkbox
                  className={classes.cardSelect}
                  checked={selected.has(instance.id)}
                  onChange={() => toggleSelect(instance.id)}
                  inputProps={{ 'aria-label': `Select ${instance.name}` }}
                />
                <Box>
                  <Typography variant="h5" gutterBottom>
                    {instance.name}
                    <Chip
                      label={instance.status}
                      color={getInstanceStatusColor(instance.status)}
                      size="small"
                      className={classes.statusChip}
                    />
                    {(() => {
                      const drift = driftChipFor(instance.driftStatus);
                      if (!drift) return null;
                      return (
                        <Tooltip title={drift.tooltip}>
                          <Chip
                            label={drift.label}
                            color={drift.color}
                            size="small"
                            variant="outlined"
                            className={classes.statusChip}
                          />
                        </Tooltip>
                      );
                    })()}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Version:</strong> {instance.version} |{' '}
                    <strong>Node:</strong> {instance.node} |{' '}
                    <strong>VMID:</strong> {instance.vmid}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>URL:</strong>{' '}
                    <a
                      href={instance.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {instance.domain}
                    </a>
                  </Typography>
                  <Typography
                    variant="body2"
                    color="textSecondary"
                    style={{ marginTop: 8 }}
                  >
                    <strong>Resources:</strong> {instance.resources.cpu} vCPU |{' '}
                    {(instance.resources.memory / 1024).toFixed(1)} GB RAM |{' '}
                    {instance.resources.storage} GB Storage
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Database:</strong> {instance.database.name} (User:{' '}
                    {instance.database.user})
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Last backup:</strong> {formatRelative(lastBackup)}
                    {lastBackup && (
                      <Typography
                        component="span"
                        variant="caption"
                        color="textSecondary"
                        style={{ marginLeft: 8 }}
                      >
                        ({new Date(lastBackup).toLocaleString()})
                      </Typography>
                    )}
                  </Typography>
                </Box>
              </Box>
              <Box className={classes.actionButtons}>
                <Tooltip title="Open DHIS2 in new tab">
                  <IconButton
                    onClick={() =>
                      window.open(
                        instance.url,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    <OpenInNewIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Refresh status">
                  <IconButton
                    onClick={() => handleRefreshOne(instance)}
                    disabled={isBusy('refresh')}
                  >
                    {isBusy('refresh') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <RefreshIcon />
                    )}
                  </IconButton>
                </Tooltip>
                {instance.status === 'stopped' && (
                  <Tooltip title="Start">
                    <IconButton
                      color="primary"
                      onClick={() => onStart(instance.id)}
                    >
                      <PlayArrowIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {instance.status === 'running' && (
                  <Tooltip title="Stop">
                    <IconButton
                      color="secondary"
                      onClick={() => handleStop(instance)}
                    >
                      <StopIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {instance.status === 'running' && (
                  <Tooltip title="Restart">
                    <IconButton onClick={() => handleRestart(instance)}>
                      <RefreshIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="View logs">
                  <IconButton onClick={() => onViewLogs(instance)}>
                    <DescriptionIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Backup now">
                  <IconButton
                    onClick={() => handleBackup(instance)}
                    disabled={isBusy('backup')}
                  >
                    {isBusy('backup') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <BackupIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Restore from backup">
                  <IconButton onClick={() => onRestore(instance)}>
                    <SettingsBackupRestoreIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Transfer database to another server">
                  <IconButton onClick={() => setTransferTarget(instance)}>
                    <SwapHorizIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Edit settings">
                  <IconButton
                    onClick={() => handleOpenEdit(instance)}
                    disabled={isBusy('edit')}
                  >
                    {isBusy('edit') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <SettingsIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton
                    color="secondary"
                    onClick={() => handleDelete(instance)}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Grid>
    );
  };

  const editDialog = (
    <Dialog
      open={!!editTarget}
      onClose={() => {
        setEditTarget(null);
        setEditDraft(null);
      }}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Edit {editTarget?.name ?? 'instance'}</DialogTitle>
      <DialogContent>
        {editDraft && (
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                label="Name"
                fullWidth
                value={editDraft.name}
                onChange={e =>
                  setEditDraft({ ...editDraft, name: e.target.value })
                }
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="DHIS2 version"
                select
                fullWidth
                value={editDraft.version}
                onChange={e =>
                  setEditDraft({ ...editDraft, version: e.target.value })
                }
                helperText="Changing the version triggers an upgrade on save"
              >
                {(versions.length > 0 ? versions : [editDraft.version]).map(
                  v => (
                    <MenuItem key={v} value={v}>
                      {v}
                    </MenuItem>
                  ),
                )}
              </TextField>
            </Grid>
            <Grid item xs={4}>
              <TextField
                label="vCPU"
                type="number"
                fullWidth
                value={editDraft.cpu}
                onChange={e =>
                  setEditDraft({
                    ...editDraft,
                    cpu: Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
            </Grid>
            <Grid item xs={4}>
              <TextField
                label="Memory (MB)"
                type="number"
                fullWidth
                value={editDraft.memoryMb}
                onChange={e =>
                  setEditDraft({
                    ...editDraft,
                    memoryMb: Math.max(512, Number(e.target.value) || 512),
                  })
                }
              />
            </Grid>
            <Grid item xs={4}>
              <TextField
                label="Storage (GB)"
                type="number"
                fullWidth
                value={editDraft.storageGb}
                onChange={e =>
                  setEditDraft({
                    ...editDraft,
                    storageGb: Math.max(5, Number(e.target.value) || 5),
                  })
                }
              />
            </Grid>
            <Grid item xs={12}>
              <Typography variant="subtitle2" style={{ marginTop: 8 }}>
                Source database
              </Typography>
              <Typography variant="caption" color="textSecondary">
                Connection details for this instance's PostgreSQL database.
                Used as the source for database transfers.
              </Typography>
            </Grid>
            <Grid item xs={12} sm={8}>
              <TextField
                label="DB host"
                fullWidth
                value={editDraft.dbHost}
                onChange={e =>
                  setEditDraft({ ...editDraft, dbHost: e.target.value })
                }
                placeholder="db.example.org"
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField
                label="DB port"
                type="number"
                fullWidth
                value={editDraft.dbPort}
                onChange={e =>
                  setEditDraft({
                    ...editDraft,
                    dbPort: Number(e.target.value) || DEFAULT_PG_PORT,
                  })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                label="DB name"
                fullWidth
                value={editDraft.dbName}
                onChange={e =>
                  setEditDraft({ ...editDraft, dbName: e.target.value })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                label="DB user"
                fullWidth
                value={editDraft.dbUser}
                onChange={e =>
                  setEditDraft({ ...editDraft, dbUser: e.target.value })
                }
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="DB password"
                type="password"
                fullWidth
                value={editDraft.dbPassword}
                onChange={e =>
                  setEditDraft({ ...editDraft, dbPassword: e.target.value })
                }
                helperText="Stored on the orchestrator and used for database transfers."
              />
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            setEditTarget(null);
            setEditDraft(null);
          }}
        >
          Cancel
        </Button>
        <Button onClick={handleSaveEdit} color="primary" variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );

  const confirmDialog = (
    <Dialog
      open={!!confirm?.open}
      onClose={() => setConfirm(null)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{confirm?.title}</DialogTitle>
      <DialogContent>
        <Typography>{confirm?.message}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirm(null)}>Cancel</Button>
        <Button
          color="secondary"
          variant="contained"
          onClick={() => {
            confirm?.onConfirm();
            setConfirm(null);
          }}
        >
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );

  const toastNode = (
    <Snackbar
      open={toast.open}
      autoHideDuration={4000}
      onClose={() => setToast(t => ({ ...t, open: false }))}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert
        severity={toast.severity}
        onClose={() => setToast(t => ({ ...t, open: false }))}
        variant="filled"
      >
        {toast.message}
      </Alert>
    </Snackbar>
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (instances.length === 0) {
    return (
      <>
        <Box textAlign="center" p={4}>
          <Typography variant="h6" color="textSecondary">
            No DHIS2 instances found
          </Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Create your first DHIS2 instance to get started
          </Typography>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={onCreateInstance}
          >
            Create Instance
          </Button>
        </Box>
        {toastNode}
      </>
    );
  }

  return (
    <>
      {renderToolbar()}
      {reconcileWarning && (
        <Box mb={2}>
          <Alert severity="info" variant="outlined">
            Proxmox reconciliation is unavailable: {reconcileWarning}
          </Alert>
        </Box>
      )}
      {unmanagedContainers.length > 0 && (
        <Box mb={2}>
          <Alert severity="warning" variant="outlined">
            <Typography variant="body2" gutterBottom>
              <strong>
                {unmanagedContainers.length} DHIS2-tagged container
                {unmanagedContainers.length === 1 ? '' : 's'} on the cluster
                {unmanagedContainers.length === 1 ? ' is' : ' are'} not in the
                Backstage registry.
              </strong>{' '}
              They were likely created outside this plugin. Investigate or
              adopt them so they appear in this list.
            </Typography>
            <Typography variant="caption" component="div">
              {unmanagedContainers
                .slice(0, 10)
                .map(c => `${c.name ?? `vmid-${c.vmid}`} (${c.node}/${c.vmid})`)
                .join(', ')}
              {unmanagedContainers.length > 10 &&
                ` and ${unmanagedContainers.length - 10} more`}
            </Typography>
          </Alert>
        </Box>
      )}
      {filtered.length === 0 ? (
        <Box textAlign="center" p={4}>
          <Typography variant="body2" color="textSecondary">
            No instances match the current filters.
          </Typography>
        </Box>
      ) : (
        <Grid container spacing={3}>
          {filtered.map(renderInstanceCard)}
        </Grid>
      )}
      {editDialog}
      {confirmDialog}
      <TransferDatabaseDialog
        open={!!transferTarget}
        instance={transferTarget}
        onClose={() => setTransferTarget(null)}
        onCompleted={() => {
          notify('success', 'Database transfer completed');
          onChanged?.();
        }}
      />
      {toastNode}
    </>
  );
};
