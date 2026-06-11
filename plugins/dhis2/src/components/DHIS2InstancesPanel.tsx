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
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import RefreshIcon from '@material-ui/icons/Refresh';
import ReplayIcon from '@material-ui/icons/Replay';
import AutorenewIcon from '@material-ui/icons/Autorenew';
import DeleteIcon from '@material-ui/icons/Delete';
import SettingsIcon from '@material-ui/icons/Settings';
import DescriptionIcon from '@material-ui/icons/Description';
import SettingsBackupRestoreIcon from '@material-ui/icons/SettingsBackupRestore';
import BackupIcon from '@material-ui/icons/Backup';
import BlockIcon from '@material-ui/icons/Block';
import SwapHorizIcon from '@material-ui/icons/SwapHoriz';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import GetAppIcon from '@material-ui/icons/GetApp';
import SystemUpdateAltIcon from '@material-ui/icons/SystemUpdateAlt';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import VpnLockIcon from '@material-ui/icons/VpnLock';
import ListAltIcon from '@material-ui/icons/ListAlt';
import ErrorOutlineIcon from '@material-ui/icons/ErrorOutline';
import { DHIS2Instance, ProxyServerSettings } from '../types';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';
import { nginxService } from '../services/nginxService';
import { findHotfix } from '../lib/versions';
import { TransferDatabaseDialog } from './TransferDatabaseDialog';
import { EditInstanceDialog } from './UpdateInstanceDialog';
import { DeleteInstanceDialog } from './DeleteInstanceDialog';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

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
  logViewer: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    background: theme.palette.background.default,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(1.5),
    flex: 1,
    minHeight: 240,
    overflow: 'auto',
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
  onDelete: (
    id: string,
    opts?: { backupDatabase?: boolean; maintainDatabase?: boolean },
  ) => void;
  /**
   * Optional Edit handler owned by the page so it can reuse the same
   * streaming activity-log dialog as Create / Delete.
   */
  onEdit?: (instance: DHIS2Instance, draft: EditDraft) => Promise<void> | void;
  /**
   * Optional Clone handler owned by the page so it can drive the
   * activity-log dialog while the ansible job runs.
   */
  onClone?: (instance: DHIS2Instance) => void;
  onUpgrade?: (
    instance: DHIS2Instance,
    opts?: { defaultVersion?: string },
  ) => void;
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
  /**
   * SSH private-key path used to reach the PVE host that runs
    * `pct exec` against this instance's LXC. Optional per-edit override;
    * when empty the backend uses its configured default orchestrator key.
   */
  sshKeyPath: string;
  tomcatVersion: '9' | '10';
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

type LogKind = 'access' | 'error';

interface LogsView {
  open: boolean;
  instanceId?: string;
  domain?: string;
  kind: LogKind;
  loading: boolean;
  lines: string[];
  path?: string;
}

const EMPTY_LOGS: LogsView = {
  open: false,
  kind: 'access',
  loading: false,
  lines: [],
};

function copyLogText(lines: string[]): void {
  const text = lines.join('\n');
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as
    | (Navigator & { clipboard?: { writeText(s: string): Promise<void> } })
    | undefined;
  if (nav?.clipboard?.writeText) {
    void nav.clipboard.writeText(text);
    return;
  }
  if (typeof document === 'undefined') return;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

function downloadLogText(lines: string[], filename: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([lines.join('\n')], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildProxyLogFilename(v: LogsView): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (v.path) {
    const base = v.path.split('/').pop() || `nginx-${v.kind}.log`;
    return `${base.replace(/\.log$/, '')}-${stamp}.log`;
  }
  const scope = v.domain ? v.domain.replace(/[^A-Za-z0-9._-]+/g, '_') : 'global';
  return `nginx-${v.kind}-${scope}-${stamp}.log`;
}

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
  onEdit,
  onClone,
  onUpgrade,
  onChanged,
  unmanagedContainers = [],
  reconcileWarning = null,
  clusterNodes,
}: DHIS2InstancesPanelProps) => {
  const classes = useStyles();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [nodeFilter, setNodeFilter] = useState<string>('all');
  const [hotfixOnly, setHotfixOnly] = useState(false);

  // Lightweight "release info" dialog opened from the hotfix / upgrade
  // chips beside an instance name. Shows links to the upstream release
  // notes / GitHub release / WAR download and offers a one-click hand-off
  // into the existing Upgrade dialog.
  const [releaseInfo, setReleaseInfo] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
    targetVersion: string;
    kind: 'hotfix' | 'upgrade';
  } | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [localBackups, setLocalBackups] = useState<Record<string, string>>({});

  const [editTarget, setEditTarget] = useState<DHIS2Instance | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [versions, setVersions] = useState<string[]>([]);

  // Per-instance nginx proxy files (upstream + vhost / "dhis.conf").
  // Loaded on demand inside the Edit dialog and edited in two textareas.
  const [proxyFilesState, setProxyFilesState] = useState<{
    loading: boolean;
    error: string | null;
    upstreamPath: string;
    upstreamContent: string;
    upstreamExists: boolean;
    sitePath: string;
    siteContent: string;
    siteExists: boolean;
    saving: boolean;
  }>({
    loading: false,
    error: null,
    upstreamPath: '',
    upstreamContent: '',
    upstreamExists: false,
    sitePath: '',
    siteContent: '',
    siteExists: false,
    saving: false,
  });
  const discoveryApi = useApi(discoveryApiRef);
  const { fetch: backstageFetch } = useApi(fetchApiRef);

  const [transferTarget, setTransferTarget] = useState<DHIS2Instance | null>(
    null,
  );

  const [deleteTarget, setDeleteTarget] = useState<DHIS2Instance | null>(null);

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

  const [proxyDefaults, setProxyDefaults] = useState<ProxyServerSettings>(
    () => settingsService.load().proxy,
  );
  const [proxySettingsOpen, setProxySettingsOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<ProxyServerSettings>(
    proxyDefaults,
  );
  const [proxyBusy, setProxyBusy] = useState<string | null>(null);
  const [disabledSites, setDisabledSites] = useState<Record<string, boolean>>(
    {},
  );
  const [proxyLogsView, setProxyLogsView] = useState<LogsView>(EMPTY_LOGS);

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

  const runProxyAction = async (
    key: string,
    label: string,
    fn: () => Promise<void | string>,
  ) => {
    setProxyBusy(key);
    try {
      const result = await fn();
      notify(
        'success',
        typeof result === 'string' ? result : `${label} succeeded`,
      );
    } catch (e: any) {
      notify('error', `${label} failed: ${e?.message ?? e}`);
    } finally {
      setProxyBusy(null);
    }
  };

  const handleTestProxyConfig = () =>
    runProxyAction('test', 'Config test', async () => {
      const res = await nginxService.testConfig();
      if (!res.success) throw new Error(res.message);
      return res.message;
    });

  const handleReloadProxyNginx = () =>
    runProxyAction('reload', 'Nginx reload', () => nginxService.reload());

  const openProxyLogs = async (
    kind: LogKind,
    instance?: { id: string; domain: string },
  ) => {
    setProxyLogsView({
      open: true,
      kind,
      instanceId: instance?.id,
      domain: instance?.domain,
      loading: true,
      lines: [],
    });
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const res = await dhis2Service.tailProxyLogs(
        baseUrl,
        instance?.id,
        { ...proxyPayloadFromSettings(), kind, lines: 200 },
        backstageFetch,
      );
      setProxyLogsView(v => ({
        ...v,
        loading: false,
        lines: res.lines,
        path: res.path,
      }));
    } catch (e: any) {
      setProxyLogsView(v => ({
        ...v,
        loading: false,
        lines: [`Failed to load logs: ${e?.message ?? e}`],
      }));
    }
  };

  const refreshProxyLogs = () => {
    if (proxyLogsView.open) {
      void openProxyLogs(
        proxyLogsView.kind,
        proxyLogsView.instanceId && proxyLogsView.domain
          ? { id: proxyLogsView.instanceId, domain: proxyLogsView.domain }
          : undefined,
      );
    }
  };

  const closeProxyLogs = () => setProxyLogsView(EMPTY_LOGS);

  const toggleProxySite = (domain: string, enabled: boolean) =>
    runProxyAction(
      `toggle:${domain}`,
      enabled ? `Enable ${domain}` : `Disable ${domain}`,
      async () => {
        if (enabled) await nginxService.enableSite(domain);
        else await nginxService.disableSite(domain);
        setDisabledSites(prev => ({ ...prev, [domain]: !enabled }));
      },
    );

  const reloadProxySite = (domain: string) =>
    runProxyAction(`reload:${domain}`, `Reload ${domain}`, () =>
      nginxService.reloadSite(domain),
    );

  const renewProxySsl = (domain: string) =>
    runProxyAction(`ssl:${domain}`, `Renew SSL for ${domain}`, () =>
      nginxService.requestCertificate(
        domain,
        proxyDefaults.letsencryptEmail ?? '',
      ),
    );

  const openProxySettings = () => {
    setProxyDraft(proxyDefaults);
    setProxySettingsOpen(true);
  };

  const closeProxySettings = () => setProxySettingsOpen(false);

  const saveProxySettings = () => {
    const current = settingsService.load();
    settingsService.save({ ...current, proxy: proxyDraft });
    setProxyDefaults(proxyDraft);
    setProxySettingsOpen(false);
    notify('success', 'Proxy settings saved');
  };

  const updateProxyDraft = <K extends keyof ProxyServerSettings>(
    key: K,
    value: ProxyServerSettings[K],
  ) => setProxyDraft(prev => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (versions.length === 0) {
      dhis2Service.getVersions().then(setVersions).catch(() => {});
    }
  }, [versions.length]);

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

  // Per-instance hotfix detection: highest patch on the same MAJOR.MINOR
  // line that is strictly greater than the deployed version.
  const hotfixByInstance = useMemo(() => {
    const map = new Map<
      string,
      { hotfix: string | null; majorUpgrade: string | null }
    >();
    if (!versions || versions.length === 0) return map;
    for (const i of instances) {
      map.set(i.id, findHotfix(i.version, versions));
    }
    return map;
  }, [instances, versions]);

  const instancesWithHotfix = useMemo(
    () =>
      instances.filter(i => !!hotfixByInstance.get(i.id)?.hotfix),
    [instances, hotfixByInstance],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return instances.filter(i => {
      if (statusFilter !== 'all' && i.status !== statusFilter) return false;
      if (nodeFilter !== 'all' && i.node !== nodeFilter) return false;
      if (hotfixOnly && !hotfixByInstance.get(i.id)?.hotfix) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.domain.toLowerCase().includes(q) ||
        i.vmid.toLowerCase().includes(q) ||
        i.database.name.toLowerCase().includes(q)
      );
    });
  }, [instances, search, statusFilter, nodeFilter, hotfixOnly, hotfixByInstance]);

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
    setDeleteTarget(instance);

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

  const proxyPayloadFromSettings = () => {
    const s = settingsService.load();
    return {
      proxy: {
        host: s.proxy.host || undefined,
        sshPort: s.proxy.sshPort || undefined,
        sshUser: s.proxy.sshUser || undefined,
        sshKeyPath: s.proxy.sshKeyPath || undefined,
        nginxConfigPath: s.proxy.nginxConfigPath || undefined,
        nginxReloadCommand: s.proxy.nginxReloadCommand || undefined,
      },
    };
  };

  const loadProxyFiles = async (instance: DHIS2Instance) => {
    setProxyFilesState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const snap = await dhis2Service.readProxyFiles(
        baseUrl,
        instance.id,
        proxyPayloadFromSettings(),
        backstageFetch,
      );
      setProxyFilesState({
        loading: false,
        error: null,
        upstreamPath: snap.upstream.path,
        upstreamContent: snap.upstream.content,
        upstreamExists: snap.upstream.exists,
        sitePath: snap.site.path,
        siteContent: snap.site.content,
        siteExists: snap.site.exists,
        saving: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProxyFilesState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  };

  const handleOpenEdit = (instance: DHIS2Instance) => {
    setEditTarget(instance);
    const globalSettings = settingsService.load();
    setEditDraft({
      name: instance.name,
      version: instance.version,
      cpu: instance.resources.cpu,
      memoryMb: instance.resources.memory,
      storageGb: instance.resources.storage,
      dbName: instance.database.name,
      dbUser: instance.database.user,
      // Fall back to the global "Database Configurations" host that was
      // used at Create-Instance time — older instance records were
      // persisted without the per-instance `database.host` field.
      dbHost: instance.database.host ?? globalSettings.dhis2.postgresHost ?? '',
      dbPort:
        instance.database.port ??
        globalSettings.dhis2.postgresPort ??
        DEFAULT_PG_PORT,
      dbPassword: instance.database.password ?? '',
      sshKeyPath: '',
      tomcatVersion: (instance.tomcatVersion as '9' | '10' | undefined) ?? '9',
    });
    setProxyFilesState({
      loading: false,
      error: null,
      upstreamPath: '',
      upstreamContent: '',
      upstreamExists: false,
      sitePath: '',
      siteContent: '',
      siteExists: false,
      saving: false,
    });
    // Best-effort load — failures surface inline in the proxy-files block.
    void loadProxyFiles(instance);
  };

  const handleSaveProxyFiles = async () => {
    if (!editTarget) return;
    setProxyFilesState(prev => ({ ...prev, saving: true, error: null }));
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      await dhis2Service.writeProxyFiles(
        baseUrl,
        editTarget.id,
        {
          ...proxyPayloadFromSettings(),
          upstream: proxyFilesState.upstreamContent,
          site: proxyFilesState.siteContent,
          reload: true,
        },
        backstageFetch,
      );
      setProxyFilesState(prev => ({
        ...prev,
        saving: false,
        upstreamExists: true,
        siteExists: true,
      }));
      setToast({
        open: true,
        severity: 'success',
        message: `Proxy files saved and nginx reloaded for ${editTarget.name}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProxyFilesState(prev => ({
        ...prev,
        saving: false,
        error: message,
      }));
    }
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editDraft) return;
    const target = editTarget;
    const draft = editDraft;
    setEditTarget(null);
    setEditDraft(null);
    await runAction(`edit:${target.id}`, `Update ${target.name}`, async () => {
      if (onEdit) {
        await onEdit(target, draft);
      }
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
      <Box style={{ flexBasis: '100%', height: 0 }} />
      <Button
        variant="outlined"
        size="small"
        startIcon={
          proxyBusy === 'test' ? <CircularProgress size={14} /> : <CheckCircleIcon />
        }
        onClick={handleTestProxyConfig}
        disabled={!!proxyBusy}
      >
        Test Config
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={
          proxyBusy === 'reload' ? <CircularProgress size={14} /> : <AutorenewIcon />
        }
        onClick={handleReloadProxyNginx}
        disabled={!!proxyBusy}
      >
        Reload Nginx
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={<DescriptionIcon />}
        onClick={() => void openProxyLogs('access')}
        disabled={!!proxyBusy}
      >
        Access Log
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={<DescriptionIcon />}
        onClick={() => void openProxyLogs('error')}
        disabled={!!proxyBusy}
      >
        Error Log
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={<SettingsIcon />}
        onClick={openProxySettings}
      >
        Proxy Settings
      </Button>
      <Box style={{ flexBasis: '100%', height: 0 }} />
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
        variant={hotfixOnly ? 'contained' : 'outlined'}
        size="small"
        color={hotfixOnly ? 'secondary' : 'default'}
        startIcon={<SystemUpdateAltIcon />}
        onClick={() => setHotfixOnly(v => !v)}
        disabled={instancesWithHotfix.length === 0 && !hotfixOnly}
      >
        {hotfixOnly
          ? `Showing ${instancesWithHotfix.length} with hotfix`
          : `Hotfix available${
              instancesWithHotfix.length > 0
                ? ` (${instancesWithHotfix.length})`
                : ''
            }`}
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
    const isProxyBusy = (action: string) =>
      proxyBusy === `${action}:${instance.domain}`;
    const drift = driftChipFor(instance.driftStatus);
    const hotfixInfo = hotfixByInstance.get(instance.id);
    const hotfix = hotfixInfo?.hotfix ?? null;
    const proxyScheme = proxyDefaults.forceHttps ? 'https' : 'http';
    const publicUrl =
      proxyDefaults.mode === 'subdomain'
        ? `${proxyScheme}://${instance.name}.${proxyDefaults.baseDomain}`
        : `${proxyScheme}://${proxyDefaults.baseDomain}/${instance.name}`;
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
                  <Box display="flex" alignItems="center" flexWrap="wrap" style={{ gap: 8 }}>
                    <Typography variant="h5" style={{ marginRight: 4 }}>
                      {instance.name}
                    </Typography>
                    {hotfix && (
                      <Tooltip title="View release information for the available hotfix">
                        <Chip
                          label={`Hotfix → ${hotfix}`}
                          size="small"
                          clickable
                          icon={<SystemUpdateAltIcon style={{ fontSize: 16, color: '#fff' }} />}
                          onClick={() =>
                            setReleaseInfo({
                              open: true,
                              instance,
                              targetVersion: hotfix,
                              kind: 'hotfix',
                            })
                          }
                          style={{ backgroundColor: '#ff9800', color: '#fff' }}
                        />
                      </Tooltip>
                    )}
                    {hotfixInfo?.majorUpgrade && (
                      <Tooltip title="View release information for the newer DHIS2 release">
                        <Chip
                          label={`Upgrade → ${hotfixInfo.majorUpgrade}`}
                          size="small"
                          clickable
                          variant="outlined"
                          icon={<SystemUpdateAltIcon style={{ fontSize: 16 }} />}
                          onClick={() =>
                            setReleaseInfo({
                              open: true,
                              instance,
                              targetVersion: hotfixInfo.majorUpgrade!,
                              kind: 'upgrade',
                            })
                          }
                          style={{ borderColor: '#1976d2', color: '#1976d2' }}
                        />
                      </Tooltip>
                    )}
                  </Box>
                  <Typography variant="body2" color="textSecondary" style={{ marginTop: 4 }}>
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
                    <strong>Database Server:</strong>{' '}
                    {instance.database.host
                      ? `${instance.database.host}:${
                          instance.database.port ?? DEFAULT_PG_PORT
                        }`
                      : 'Local (inside instance)'}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Public URL:</strong>{' '}
                    <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                      {publicUrl}
                    </a>
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    <strong>Proxy:</strong> {proxyDefaults.sshUser}@
                    {proxyDefaults.host || '?'}:{proxyDefaults.sshPort} |{' '}
                    {proxyDefaults.nginxConfigPath}/{instance.name}.conf
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
              <Box display="flex" flexDirection="column" alignItems="flex-end">
                <Box display="flex" alignItems="center" flexWrap="wrap" justifyContent="flex-end">
                  <Chip
                    label={instance.status}
                    color={getInstanceStatusColor(instance.status)}
                    size="small"
                    className={classes.statusChip}
                  />
                  {instance.version && (
                    <Tooltip
                      title={
                        hotfix
                          ? `Currently on DHIS2 ${instance.version} — patch ${hotfix} is available in the same release line.`
                          : `DHIS2 version (up to date)`
                      }
                    >
                      <Chip
                        label={`DHIS2 ${instance.version}`}
                        size="small"
                        variant="outlined"
                        className={classes.statusChip}
                      />
                    </Tooltip>
                  )}
                  {drift && (
                    <Tooltip title={drift.tooltip}>
                      <Chip
                        label={drift.label}
                        color={drift.color}
                        size="small"
                        variant="outlined"
                        className={classes.statusChip}
                      />
                    </Tooltip>
                  )}
                  <Chip
                    label={proxyDefaults.mode === 'subdomain' ? 'subdomain' : 'path'}
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
                  {disabledSites[instance.domain] && (
                    <Chip
                      label="PROXY DISABLED"
                      size="small"
                      color="secondary"
                      className={classes.statusChip}
                    />
                  )}
                </Box>
                <Box className={classes.actionButtons} style={{ marginTop: 8 }}>
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
                      <ReplayIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {instance.status === 'running' && (
                  <Tooltip title="View logs">
                    <IconButton onClick={() => onViewLogs(instance)}>
                      <DescriptionIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="View nginx access log for this site">
                  <IconButton
                    onClick={() => void openProxyLogs('access', instance)}
                  >
                    <ListAltIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="View nginx error log for this site">
                  <IconButton
                    onClick={() => void openProxyLogs('error', instance)}
                  >
                    <ErrorOutlineIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Reload nginx for this site">
                  <IconButton
                    disabled={isProxyBusy('reload')}
                    onClick={() => reloadProxySite(instance.domain)}
                  >
                    {isProxyBusy('reload') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <AutorenewIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Renew SSL certificate">
                  <IconButton
                    disabled={isProxyBusy('ssl')}
                    onClick={() => renewProxySsl(instance.domain)}
                  >
                    {isProxyBusy('ssl') ? (
                      <CircularProgress size={20} />
                    ) : (
                      <VpnLockIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip
                  title={
                    disabledSites[instance.domain] ? 'Enable site' : 'Disable site'
                  }
                >
                  <IconButton
                    disabled={isProxyBusy('toggle')}
                    onClick={() =>
                      toggleProxySite(instance.domain, !!disabledSites[instance.domain])
                    }
                  >
                    {isProxyBusy('toggle') ? (
                      <CircularProgress size={20} />
                    ) : disabledSites[instance.domain] ? (
                      <CheckCircleIcon />
                    ) : (
                      <BlockIcon />
                    )}
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
                <Tooltip title="Clone to new environment">
                  <span>
                    <IconButton
                      onClick={() => onClone?.(instance)}
                      disabled={!onClone}
                    >
                      <FileCopyIcon />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Upgrade DHIS2 WAR">
                  <span>
                    <IconButton
                      onClick={() => onUpgrade?.(instance)}
                      disabled={!onUpgrade}
                    >
                      <SystemUpdateAltIcon />
                    </IconButton>
                  </span>
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
            </Box>
          </CardContent>
        </Card>
      </Grid>
    );
  };

  const editDialog = (
    <EditInstanceDialog
      open={!!editTarget}
      instance={editTarget}
      draft={editDraft}
      versions={versions}
      proxyFilesState={proxyFilesState}
      onClose={() => {
        setEditTarget(null);
        setEditDraft(null);
      }}
      onDraftChange={setEditDraft}
      onProxyFilesChange={setProxyFilesState}
      onReloadProxyFiles={() => {
        if (editTarget) void loadProxyFiles(editTarget);
      }}
      onSaveProxyFiles={handleSaveProxyFiles}
      onSave={handleSaveEdit}
    />
  );

  const deleteDialog = (
    <DeleteInstanceDialog
      open={!!deleteTarget}
      instance={deleteTarget}
      onClose={() => setDeleteTarget(null)}
      onConfirm={({ backupDatabase, maintainDatabase }) => {
        if (!deleteTarget) return;
        onDelete(deleteTarget.id, { backupDatabase, maintainDatabase });
        setDeleteTarget(null);
      }}
    />
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

  const proxySettingsDialog = (
    <Dialog open={proxySettingsOpen} onClose={closeProxySettings} maxWidth="sm" fullWidth>
      <DialogTitle>Reverse Proxy Settings</DialogTitle>
      <DialogContent>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField
              label="Proxy host"
              fullWidth
              value={proxyDraft.host}
              onChange={e => updateProxyDraft('host', e.target.value)}
              helperText="SSH-reachable hostname or IP of the proxy server"
              placeholder="10.20.30.143"
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH port"
              type="number"
              fullWidth
              value={proxyDraft.sshPort}
              onChange={e => updateProxyDraft('sshPort', Number(e.target.value) || 22)}
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH user"
              fullWidth
              value={proxyDraft.sshUser}
              onChange={e => updateProxyDraft('sshUser', e.target.value)}
            />
          </Grid>
          <Grid item xs={6}>
            <TextField
              label="SSH auth"
              select
              fullWidth
              value={proxyDraft.authMethod}
              onChange={e =>
                updateProxyDraft(
                  'authMethod',
                  e.target.value as ProxyServerSettings['authMethod'],
                )
              }
            >
              <MenuItem value="ssh-key">ssh-key</MenuItem>
              <MenuItem value="password">password</MenuItem>
            </TextField>
          </Grid>
          {proxyDraft.authMethod === 'ssh-key' ? (
            <Grid item xs={12}>
              <TextField
                label="SSH private key path"
                fullWidth
                value={proxyDraft.sshKeyPath ?? ''}
                onChange={e => updateProxyDraft('sshKeyPath', e.target.value)}
                helperText="Path on the Backstage backend host"
                placeholder="/root/.ssh/id_ed25519"
              />
            </Grid>
          ) : (
            <Grid item xs={12}>
              <TextField
                label="SSH password"
                type="password"
                fullWidth
                value={proxyDraft.sshPassword ?? ''}
                onChange={e => updateProxyDraft('sshPassword', e.target.value)}
                helperText="Stored locally in browser settings"
              />
            </Grid>
          )}
          <Grid item xs={12}>
            <TextField
              label="Nginx config directory"
              fullWidth
              value={proxyDraft.nginxConfigPath}
              onChange={e => updateProxyDraft('nginxConfigPath', e.target.value)}
              helperText="e.g. /etc/nginx/upstream — directory for per-instance snippets (one <instance>.conf per instance, no subfolders). Created if missing."
              placeholder="/etc/nginx/upstream"
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label="Nginx reload command"
              fullWidth
              value={proxyDraft.nginxReloadCommand}
              onChange={e => updateProxyDraft('nginxReloadCommand', e.target.value)}
              placeholder="sudo systemctl reload nginx"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeProxySettings}>Cancel</Button>
        <Button onClick={saveProxySettings} color="primary" variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );

  const proxyLogsDialog = (
    <Dialog open={proxyLogsView.open} onClose={closeProxyLogs} maxWidth="md" fullWidth>
      <DialogTitle>
        Nginx {proxyLogsView.kind === 'access' ? 'access' : 'error'} log
        {proxyLogsView.domain ? ` — ${proxyLogsView.domain}` : ' — global'}
        {proxyLogsView.path && (
          <Typography variant="caption" display="block" color="textSecondary">
            {proxyLogsView.path}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent
        dividers
        style={{
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {proxyLogsView.loading ? (
          <Box display="flex" justifyContent="center" p={4}>
            <CircularProgress />
          </Box>
        ) : proxyLogsView.lines.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            No log entries.
          </Typography>
        ) : (
          <Box className={classes.logViewer}>{proxyLogsView.lines.join('\n')}</Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={refreshProxyLogs} startIcon={<RefreshIcon />}>
          Refresh
        </Button>
        <Button
          onClick={() => copyLogText(proxyLogsView.lines)}
          startIcon={<FileCopyIcon />}
          disabled={proxyLogsView.loading || proxyLogsView.lines.length === 0}
        >
          Copy
        </Button>
        <Button
          onClick={() =>
            downloadLogText(
              proxyLogsView.lines,
              buildProxyLogFilename(proxyLogsView),
            )
          }
          startIcon={<GetAppIcon />}
          disabled={proxyLogsView.loading || proxyLogsView.lines.length === 0}
        >
          Download
        </Button>
        <Button onClick={closeProxyLogs}>Close</Button>
      </DialogActions>
    </Dialog>
  );

  const releaseInfoDialog = (() => {
    const closeRelease = () => setReleaseInfo(null);
    const target = releaseInfo?.targetVersion ?? '';
    const cleanTarget = target.replace(/^2\./, '');
    const major = cleanTarget.split('.')[0] || '';
    const patch = cleanTarget.split('.')[1] || '0';
    const hotfix = cleanTarget.split('.')[2] || '0';
    const releaseNotesUrl = major
      ? `https://docs.dhis2.org/en/full/use/dhis-core-version-${major}/release-notes.html`
      : '';
    const githubUrl = cleanTarget
      ? `https://github.com/dhis2/dhis2-core/releases/tag/${cleanTarget}`
      : '';
    const warUrl = major
      ? `https://releases.dhis2.org/${major}/dhis2-stable-${major}.${patch}.${hotfix}.war`
      : '';
    const downloadsUrl = 'https://dhis2.org/downloads/';
    const instance = releaseInfo?.instance ?? null;
    const isHotfix = releaseInfo?.kind === 'hotfix';
    return (
      <Dialog
        open={!!releaseInfo?.open}
        onClose={closeRelease}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {isHotfix ? 'Hotfix' : 'Upgrade'} available: DHIS2 {target}
        </DialogTitle>
        <DialogContent dividers>
          {instance && (
            <Typography variant="body2" color="textSecondary" gutterBottom>
              Instance <strong>{instance.name}</strong> is currently running
              DHIS2 <strong>{instance.version}</strong>. A newer{' '}
              {isHotfix ? 'patch in the same release line' : 'release line'}{' '}
              is available.
            </Typography>
          )}
          <Box mt={2}>
            <Typography variant="subtitle2" gutterBottom>
              Release information
            </Typography>
            <Typography variant="body2" component="div">
              <ul style={{ paddingLeft: 18, marginTop: 4, marginBottom: 4 }}>
                {releaseNotesUrl && (
                  <li>
                    <a
                      href={releaseNotesUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Official release notes (v{major})
                    </a>
                  </li>
                )}
                {githubUrl && (
                  <li>
                    <a href={githubUrl} target="_blank" rel="noopener noreferrer">
                      GitHub release {cleanTarget}
                    </a>
                  </li>
                )}
                {warUrl && (
                  <li>
                    <a href={warUrl} target="_blank" rel="noopener noreferrer">
                      Direct WAR download
                    </a>
                  </li>
                )}
                <li>
                  <a
                    href={downloadsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    DHIS2 downloads page
                  </a>
                </li>
              </ul>
            </Typography>
          </Box>
          {!isHotfix && (
            <Box mt={2}>
              <Alert severity="info" variant="outlined">
                Cross-version upgrades may require database migrations and
                compatibility review. Always test in a staging clone first.
              </Alert>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRelease}>Close</Button>
          {instance && onUpgrade && (
            <Button
              color="primary"
              variant="contained"
              startIcon={<SystemUpdateAltIcon />}
              onClick={() => {
                onUpgrade(instance, { defaultVersion: target });
                closeRelease();
              }}
            >
              Upgrade to {target}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    );
  })();

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
      {instancesWithHotfix.length > 0 && (
        <Box mb={2}>
          <Alert
            severity="warning"
            variant="outlined"
            icon={<SystemUpdateAltIcon fontSize="inherit" />}
            action={
              <Button
                size="small"
                color="inherit"
                onClick={() => setHotfixOnly(v => !v)}
              >
                {hotfixOnly ? 'Show all' : 'Show only these'}
              </Button>
            }
          >
            <Typography variant="body2" gutterBottom>
              <strong>
                {instancesWithHotfix.length} instance
                {instancesWithHotfix.length === 1 ? '' : 's'}{' '}
                {instancesWithHotfix.length === 1 ? 'is' : 'are'} missing a
                DHIS2 hotfix.
              </strong>{' '}
              A newer patch is available within the same release line.
              Click the orange chip on each card to upgrade.
            </Typography>
            <Typography variant="caption" component="div">
              {instancesWithHotfix
                .slice(0, 10)
                .map(i => {
                  const hf = hotfixByInstance.get(i.id)?.hotfix;
                  return `${i.name} (${i.version} → ${hf ?? '?'})`;
                })
                .join(', ')}
              {instancesWithHotfix.length > 10 &&
                ` and ${instancesWithHotfix.length - 10} more`}
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
      {deleteDialog}
      {confirmDialog}
      {proxySettingsDialog}
      {proxyLogsDialog}
      {releaseInfoDialog}
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
