import React, { useState, useEffect, useRef } from 'react';
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
  Tooltip,
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
import FileCopyIcon from '@material-ui/icons/FileCopy';
import PauseIcon from '@material-ui/icons/Pause';
import StopIcon from '@material-ui/icons/Stop';
import ReplayIcon from '@material-ui/icons/Replay';
import VerticalAlignBottomIcon from '@material-ui/icons/VerticalAlignBottom';
import SpeedIcon from '@material-ui/icons/Speed';
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
import { CloneInstanceDialog } from './CloneInstanceDialog';
import { UpgradeInstanceDialog } from './UpgradeInstanceDialog';
import { CloneInstancePayload } from '../services/dhis2Service';
import { UpgradeInstancePayload } from '../services/dhis2Service';
import { DHIS2InstancesPanel } from './DHIS2InstancesPanel';
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

// Activity-log phase classification. The Ansible output emits headers like
// `PLAY [Phase 1 — …]` and per-task lines like `TASK [postgres : …]`. We use
// these to group the streaming log into visually distinct sections so the
// PostgreSQL and DHIS2 stages (which both live inside Phase 4) are easy to
// tell apart at a glance.
type LogPhase =
  | 'Submit'
  | 'Proxmox'
  | 'Bootstrap'
  | 'Preflight'
  | 'Restore'
  | 'Common'
  | 'PostgreSQL'
  | 'DBRestore'
  | 'DHIS2'
  | 'Nginx'
  | 'Finalize'
  | 'Error'
  | 'General';

const PHASE_COLORS: Record<LogPhase, string> = {
  Submit: '#9ca3af',
  Proxmox: '#fbbf24',
  Bootstrap: '#fb923c',
  Preflight: '#a3a3a3',
  Restore: '#c084fc',
  Common: '#94a3b8',
  PostgreSQL: '#60a5fa',
  DBRestore: '#a78bfa',
  DHIS2: '#34d399',
  Nginx: '#f472b6',
  Finalize: '#22d3ee',
  Error: '#f87171',
  General: '#6b7280',
};

// Human-friendly section headers shown in the activity log. Keys default to
// the phase name when not listed here.
const PHASE_LABELS: Partial<Record<LogPhase, string>> = {
  Restore: 'Stage backup',
  PostgreSQL: 'Database installation',
  DBRestore: 'Database restore',
};

const phaseLabel = (phase: LogPhase): string => PHASE_LABELS[phase] ?? phase;

const classifyPhase = (line: string, prev: LogPhase): LogPhase => {
  // Strip the leading "[hh:mm:ss] " timestamp that appendProvisionLog adds.
  const raw = line.replace(/^\[[^\]]+\]\s*/, '');

  if (/^ERROR:/i.test(raw)) return 'Error';

  // PLAY headers from Ansible mark the start of a new top-level phase.
  const playMatch = raw.match(/PLAY \[([^\]]+)\]/i);
  if (playMatch) {
    const name = playMatch[1];
    if (/Phase 1\b/i.test(name)) return 'Proxmox';
    if (/Phase 2b\b/i.test(name)) return 'Bootstrap';
    if (/Phase 2\b/i.test(name)) return 'Bootstrap';
    if (/Pre-?flight/i.test(name)) return 'Preflight';
    if (/Phase 3\b|stage restore/i.test(name)) return 'Restore';
    if (/Phase 4\b|provision DHIS2/i.test(name)) return 'Common';
    // Phase 5a registers the proxy host (add_host) and Phase 5b runs the
    // proxy role to write nginx config + request the TLS cert. Both should
    // appear under the Nginx section header in the activity log.
    if (/Phase 5[ab]?\b|central Nginx|reverse proxy/i.test(name)) return 'Nginx';
    return prev;
  }

  // TASK lines reveal which role is currently running inside Phase 4.
  const taskMatch = raw.match(/TASK \[([a-zA-Z0-9_\-]+)\s*:\s*([^\]]*)\]/);
  if (taskMatch) {
    const role = taskMatch[1].toLowerCase();
    const taskName = (taskMatch[2] || '').trim();
    if (role === 'pve_lxc') return 'Proxmox';
    if (role === 'lxc_bootstrap') return 'Bootstrap';
    if (role === 'stage_restore') return 'Restore';
    if (role === 'common') return 'Common';
    if (role === 'postgres' || role === 'postgresql') {
      // restore.yml inside the postgres role uses task names prefixed with
      // "Restore |" — surface those under their own "Database restore"
      // header so it's clear when the playbook moves from installing
      // PostgreSQL/creating the DB to loading the dump.
      if (/^Restore\s*\|/i.test(taskName)) return 'DBRestore';
      return 'PostgreSQL';
    }
    if (role === 'dhis2') return 'DHIS2';
    if (role === 'nginx' || role === 'proxy') return 'Nginx';
    return prev;
  }

  // Wrapper / backend markers from create-instance.sh and the backend.
  if (/Phase 1 — creating LXC|container IP:/i.test(raw)) return 'Proxmox';
  if (/Phase 2 — rendering inventory|running ansible-playbook/i.test(raw)) {
    return prev === 'Submit' || prev === 'Proxmox' ? 'Bootstrap' : prev;
  }
  if (/Phase 3 — configuring central Nginx/i.test(raw)) return 'Nginx';
  if (/DHIS2 provisioning complete|provisioned successfully/i.test(raw)) {
    return 'Finalize';
  }
  if (/Starting provisioning|Backend accepted job|Streaming progress/i.test(raw)) {
    return 'Submit';
  }

  return prev;
};

interface LogGroup {
  phase: LogPhase;
  lines: string[];
}

const groupLogByPhase = (lines: string[]): LogGroup[] => {
  const groups: LogGroup[] = [];
  let current: LogPhase = 'Submit';
  for (const line of lines) {
    const next = classifyPhase(line, current);
    if (groups.length === 0 || next !== current) {
      groups.push({ phase: next, lines: [line] });
      current = next;
    } else {
      groups[groups.length - 1].lines.push(line);
    }
  }
  return groups;
};

export const DHIS2Page = () => {
  const classes = useStyles();
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const [instances, setInstances] = useState<DHIS2Instance[]>([]);
  // Reconciliation report from the backend (containers in the cluster
  // tagged `dhis2` but not in the registry, plus any reason Proxmox
  // could not be reached). Refreshed alongside `loadInstances`.
  const [unmanagedContainers, setUnmanagedContainers] = useState<
    Array<{
      vmid: number;
      node: string;
      name?: string;
      tags?: string;
      status?: string;
    }>
  >([]);
  const [reconcileWarning, setReconcileWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // Bumped after a successful provisioning run so the CreateInstanceDialog
  // remounts with a fresh form. While provisioning is in progress (or has
  // failed) we keep the same key so the form values stay intact and the
  // user can retry without re-entering everything.
  const [createDialogKey, setCreateDialogKey] = useState(0);
  const [tabValue, setTabValue] = useState(0);
  const [nodes, setNodes] = useState<ProxmoxNode[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [logsDialog, setLogsDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
    lines: string[];
    loading: boolean;
    source: 'auto' | 'dhis2' | 'catalina';
    path?: string;
    error?: string;
  }>({
    open: false,
    instance: null,
    lines: [],
    loading: false,
    source: 'auto',
  });

  // Restore-from-backup state for the Create dialog.

  // Post-create restore dialog (Restore icon on an existing instance card).
  const [restoreDialog, setRestoreDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
  }>({ open: false, instance: null });

  // Clone dialog state — owned by the page so the activity-log dialog can
  // surface the underlying ansible job progress.
  const [cloneDialog, setCloneDialog] = useState<{
    open: boolean;
    source: DHIS2Instance | null;
    suggestedVmid: number | null;
    submitting: boolean;
    error: string | null;
  }>({
    open: false,
    source: null,
    suggestedVmid: null,
    submitting: false,
    error: null,
  });

  // Upgrade dialog state — drives the in-place WAR swap flow.
  const [upgradeDialog, setUpgradeDialog] = useState<{
    open: boolean;
    instance: DHIS2Instance | null;
    submitting: boolean;
    error: string | null;
    defaultVersion?: string;
  }>({ open: false, instance: null, submitting: false, error: null });

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
  const [logCopied, setLogCopied] = useState(false);

  // --- Activity log: live tail + replay controls -------------------------
  // The activity log Paper auto-scrolls to the newest line by default. When
  // the user scrolls up to inspect earlier output, auto-scroll pauses until
  // they scroll back to the bottom (or hit the "jump to bottom" button).
  // After a run finishes (success or failure), the operator can replay the
  // run line-by-line at 1x/2x/4x speed for a quick walkthrough/demo.
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lastRunLog, setLastRunLog] = useState<string[]>([]);
  const [replayActive, setReplayActive] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  // ms per line; lower = faster. Cycles 1x (50) -> 2x (25) -> 4x (10).
  const [replaySpeed, setReplaySpeed] = useState(50);

  // Snapshot the log on completion so it can be replayed even if the live
  // buffer is later cleared by another provisioning run.
  useEffect(() => {
    if ((provisionDone || provisionError) && provisionLog.length > 0) {
      setLastRunLog(provisionLog);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provisionDone, provisionError]);

  // Auto-scroll to the bottom when new lines arrive (live mode only).
  useEffect(() => {
    if (replayActive) return;
    if (!autoScroll) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [provisionLog, replayActive, autoScroll]);

  // Auto-scroll while replaying too.
  useEffect(() => {
    if (!replayActive) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replayIndex, replayActive]);

  // Replay tick: reveal one more line every `replaySpeed` ms while playing.
  useEffect(() => {
    if (!replayPlaying) return undefined;
    const id = window.setInterval(() => {
      setReplayIndex(prev => {
        if (prev >= lastRunLog.length) {
          setReplayPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, replaySpeed);
    return () => window.clearInterval(id);
  }, [replayPlaying, replaySpeed, lastRunLog.length]);

  useEffect(() => {
    loadInstances();
    loadNodes();
    loadVersions();
  }, []);

  const loadInstances = async () => {
    setLoading(true);
    try {
      // The backend's persisted registry is the source of truth for what
      // is actually deployed. Use it directly \u2014 the mock list from
      // `dhis2Service.getInstances()` is reserved as a last-resort
      // fallback when the backend is unreachable (e.g. during local UI
      // development without the dhis2-backend running).
      try {
        const baseUrl = await discoveryApi.getBaseUrl('dhis2');
        const persisted = await dhis2Service.getPersistedInstances(
          baseUrl,
          backstageFetch,
        );
        setInstances(persisted);
        // Pull the reconciliation report so the panel can surface drift.
        // Failures are non-fatal \u2014 the panel just won't show the banner.
        try {
          const report = await dhis2Service.getInstanceReconciliation(
            baseUrl,
            backstageFetch,
          );
          setUnmanagedContainers(report.unmanaged ?? []);
          setReconcileWarning(
            report.proxmoxReachable
              ? null
              : report.unreachableReason ?? 'Proxmox API not reachable',
          );
        } catch {
          setUnmanagedContainers([]);
          setReconcileWarning(null);
        }
      } catch {
        // Backend unreachable \u2014 fall back to mock list so the UI is
        // still usable in standalone dev mode.
        const data = await dhis2Service.getInstances();
        setInstances(data);
        setUnmanagedContainers([]);
        setReconcileWarning(null);
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

  // Log-line markers from create-instance.sh / Ansible output that we use
  // to advance the visible step list. Order matters: later matches "complete"
  // earlier steps.
  const STEP_MARKERS: Array<{ pattern: RegExp; advanceTo: string }> = [
    { pattern: /Phase 1 — creating LXC container/i, advanceTo: 'container' },
    { pattern: /Phase 1 — update LXC resources|PLAY \[Phase 1 — update LXC/i, advanceTo: 'resize' },
    { pattern: /container IP:/i, advanceTo: 'bootstrap' },
    { pattern: /PLAY \[Phase 2\b|TASK \[lxc_bootstrap\s*:/i, advanceTo: 'bootstrap' },
    { pattern: /Phase 2a — register PVE host|PLAY \[Phase 2a/i, advanceTo: 'dhis2config' },
    { pattern: /Phase 2 — apply DHIS2 config changes inside LXC|PLAY \[Phase 2 — apply DHIS2 config changes/i, advanceTo: 'dhis2config' },
    { pattern: /Phase 2 — rendering inventory|running ansible-playbook/i, advanceTo: 'bootstrap' },
    { pattern: /TASK \[postgres\s*:/i, advanceTo: 'postgres' },
    { pattern: /TASK \[dhis2\s*:/i, advanceTo: 'dhis2' },
    { pattern: /systemctl restart tomcat/i, advanceTo: 'restart' },
    // Phase 5 became an Ansible play (roles/proxy) instead of a shell-out
    // to configure-proxy.sh. Match the new play/task headers so the
    // UI advances to the 'proxy' step when Ansible reaches them; keep the
    // legacy patterns as fallbacks in case an older script is in use.
    { pattern: /PLAY \[Phase 5[ab]?\b|TASK \[proxy\s*:|Phase 3 — configuring central Nginx|TASK \[nginx\s*:/i, advanceTo: 'proxy' },
    { pattern: /DHIS2 provisioning complete/i, advanceTo: 'finalize' },
    // Lifecycle (start / stop / restart) phases driven by lifecycle.yml.
    { pattern: /PLAY \[Phase 1 — (start|stop|restart) LXC/i, advanceTo: 'lxc' },
    { pattern: /PLAY \[Phase 2 — wait for LXC/i, advanceTo: 'settle' },
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

    // Steps modelled on create-instance.sh / site.yml phases. Postgres
    // runs before DHIS2 in the playbook (roles: [common, postgres, dhis2]),
    // so the progress indicator lists them in execution order.
    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'container', label: `Phase 1 — creating LXC container (vmid will be allocated by orchestrator)`, status: 'pending' },
      { key: 'bootstrap', label: `Phase 2 — bootstrapping container`, status: 'pending' },
      { key: 'postgres', label: `Phase 3 — running Ansible (PostgreSQL)`, status: 'pending' },
      { key: 'dhis2', label: `Phase 4 — running Ansible (DHIS2 ${request.version})`, status: 'pending' },
      { key: 'proxy', label: `Phase 5 — configuring Nginx for ${derivedDomain}`, status: 'pending' },
      { key: 'finalize', label: 'Finalizing instance', status: 'pending' },
    ];

    setProvisionInstanceName(request.name);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    // Drop any active replay from a previous run.
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(`Starting provisioning for "${request.name}".`);

    // Email comes from saved settings; VMID is allocated by backend via
    // Proxmox /cluster/nextid at submit time.
    const settings = settingsService.load();
    const email = proxySettings.letsencryptEmail || settings.proxy.letsencryptEmail || 'admin@example.com';
    const proxmoxOverrides = (() => {
      const pm = settings.proxmox;
      const apiUrl = (pm.apiUrl ?? '').trim();
      const tokenId = (pm.tokenId ?? '').trim();
      const tokenSecret = (pm.tokenSecret ?? '').trim();
      const username = (pm.username ?? '').trim();
      const fields: {
        apiUrl?: string;
        apiUser?: string;
        apiTokenId?: string;
        apiTokenSecret?: string;
        validateApiCerts?: boolean;
      } = {};
      if (apiUrl) fields.apiUrl = apiUrl;
      if (pm.authMethod === 'token') {
        if (tokenId) fields.apiTokenId = tokenId;
        if (tokenSecret) fields.apiTokenSecret = tokenSecret;
        // If tokenId already encodes the user (root@pam!backstage), the
        // backend extracts the user from it. Otherwise fall back to the
        // explicit username field when set.
        if (!tokenId.includes('!') && username) fields.apiUser = username;
      }
      // Always forward TLS preference so it tracks the panel toggle.
      fields.validateApiCerts = Boolean(pm.verifyTls);
      return Object.keys(fields).length > 0 ? fields : undefined;
    })();

    // If the operator has configured a shared/external PostgreSQL host in
    // Database Configurations, route the new instance's database there. The
    // postgres role on the orchestrator will connect to it as the admin
    // user and create (or just attach to, when existing=true) the DHIS2
    // database. When postgresHost is blank we fall back to today's
    // behaviour: install PostgreSQL inside the LXC container itself.
    const dhis2Cfg = request.dhis2Settings ?? settings.dhis2;
    const remotePg = (dhis2Cfg.postgresHost ?? '').trim();
    const provisionPayload = {
      name: request.name,
      domain: derivedDomain,
      version: request.version,
      node: request.node,
      vmid: 0,
      hostname: request.name,
      email,
      resources: request.resources,
      database: {
        name: request.database.name,
        user: request.database.user,
        password: request.database.password,
        existing: request.database.existing,
        host: request.database.host ?? (remotePg ? remotePg : undefined),
        port:
          request.database.port ??
          (remotePg ? dhis2Cfg.postgresPort : undefined),
      },
      // Admin role used by the postgres Ansible tasks to CREATE the per-
      // instance database/user on the shared host. Only sent when a remote
      // host is actually configured.
      databaseAdmin: remotePg
        ? {
            user: dhis2Cfg.postgresAdminUser || 'postgres',
            password: dhis2Cfg.postgresAdminPassword || '',
          }
        : undefined,
      rootPassword: request.rootPassword,
      newDbAccount: request.newDbAccount,
      deleteIfExists: request.deleteIfExists,
      deleteIfNameExists: request.deleteIfNameExists,
      tomcatVersion: request.tomcatVersion,
      proxyOverride: request.proxyOverride,
      restore: request.restore,
      proxySettings,
      dhis2Settings: request.dhis2Settings,
      // Forward Proxmox API credentials from the ProxmoxClusterPanel saved
      // settings so the operator can override the server-side defaults
      // (PROXMOX_API_URL / PROXMOX_USER / PROXMOX_TOKEN_ID /
      // PROXMOX_TOKEN_SECRET) per-job. Only non-empty fields are sent —
      // anything blank falls back to the backend config / env vars.
      proxmox: proxmoxOverrides,
      // Forward Reverse-Proxy panel settings so Phase 5's `proxy` role
      // SSHes to the dedicated proxy server (host, port, user, key)
      // and writes nginx configs to the operator-chosen directory using
      // the operator-chosen reload command. When a field is blank we
      // omit it so create-instance.sh applies its fallback (PVE host
      // for single-node setups, /etc/nginx/upstream + `nginx -s reload`
      // for the layout, etc.).
      proxy: (() => {
        const p = proxySettings;
        const fields: {
          host?: string;
          sshPort?: number;
          sshUser?: string;
          sshKeyPath?: string;
          nginxConfigPath?: string;
          nginxReloadCommand?: string;
        } = {};
        const host = (p.host ?? '').trim();
        const sshUser = (p.sshUser ?? '').trim();
        const sshKeyPath = (p.sshKeyPath ?? '').trim();
        const nginxConfigPath = (p.nginxConfigPath ?? '').trim();
        const nginxReloadCommand = (p.nginxReloadCommand ?? '').trim();
        if (host) fields.host = host;
        if (Number.isInteger(p.sshPort) && p.sshPort > 0) {
          fields.sshPort = p.sshPort;
        }
        if (sshUser) fields.sshUser = sshUser;
        if (sshKeyPath) fields.sshKeyPath = sshKeyPath;
        if (nginxConfigPath) fields.nginxConfigPath = nginxConfigPath;
        if (nginxReloadCommand) {
          fields.nginxReloadCommand = nginxReloadCommand;
        }
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
    };

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const vmid = await dhis2Service.getNextVmid(
        baseUrl,
        proxmoxOverrides,
        backstageFetch,
      );
      provisionPayload.vmid = vmid;
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
          // Job succeeded — close the Create dialog and bump its key so the
          // next "Create Instance" click starts with a clean form.
          setCreateDialogOpen(false);
          setCreateDialogKey(k => k + 1);
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

  const runLifecycleAction = async (
    instance: DHIS2Instance,
    action: 'start' | 'stop' | 'restart',
  ) => {
    const verbing =
      action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
    const steps: ProvisionStep[] = [
      { key: 'submit', label: `Submitting ${verbing} job to backend`, status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'lxc', label: `Phase 1 — ${verbing} LXC ${instance.vmid} on ${instance.node}`, status: 'pending' },
      { key: 'settle', label: 'Phase 2 — wait for LXC to settle', status: 'pending' },
      { key: 'finalize', label: `Finalizing ${verbing}`, status: 'pending' },
    ];
    setProvisionInstanceName(`${instance.name} (${verbing})`);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(`Starting ${verbing} for "${instance.name}".`);

    const settings = settingsService.load();
    const pm = settings.proxmox;
    const payload: {
      action: 'start' | 'stop' | 'restart';
      proxmox?: {
        apiUrl?: string;
        apiUser?: string;
        apiTokenId?: string;
        apiTokenSecret?: string;
        validateApiCerts?: boolean;
      };
    } = {
      action,
      proxmox: (() => {
        const apiUrl = (pm.apiUrl ?? '').trim();
        const tokenId = (pm.tokenId ?? '').trim();
        const tokenSecret = (pm.tokenSecret ?? '').trim();
        const username = (pm.username ?? '').trim();
        const fields: {
          apiUrl?: string;
          apiUser?: string;
          apiTokenId?: string;
          apiTokenSecret?: string;
          validateApiCerts?: boolean;
        } = {};
        if (apiUrl) fields.apiUrl = apiUrl;
        if (pm.authMethod === 'token') {
          if (tokenId) fields.apiTokenId = tokenId;
          if (tokenSecret) fields.apiTokenSecret = tokenSecret;
          if (!tokenId.includes('!') && username) fields.apiUser = username;
        }
        fields.validateApiCerts = Boolean(pm.verifyTls);
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
    };

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startLifecycleJob(
        baseUrl,
        instance.id,
        payload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);

      let lastLineCount = 0;
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
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
          if (job.lines.length > 0) advanceSteps('lxc');
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
            `Instance "${instance.name}" ${verbing} completed (exit 0).`,
          );
          loadInstances();
          break;
        }
        const message = job.error ?? `Lifecycle ${verbing} failed (exit ${job.exitCode ?? '?'})`;
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
      console.error(`Failed to ${verbing} instance:`, error);
      const message = error instanceof Error ? error.message : String(error);
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
    const instance = instances.find(i => i.id === id);
    if (!instance) {
      console.warn(`Start: instance ${id} not found in local state`);
      return;
    }
    await runLifecycleAction(instance, 'start');
  };

  const handleStopInstance = async (id: string) => {
    const instance = instances.find(i => i.id === id);
    if (!instance) {
      console.warn(`Stop: instance ${id} not found in local state`);
      return;
    }
    await runLifecycleAction(instance, 'stop');
  };

  const handleRestartInstance = async (id: string) => {
    const instance = instances.find(i => i.id === id);
    if (!instance) {
      console.warn(`Restart: instance ${id} not found in local state`);
      return;
    }
    await runLifecycleAction(instance, 'restart');
  };

  const handleDeleteInstance = async (id: string) => {
    const instance = instances.find(i => i.id === id);
    if (!instance) {
      console.warn(`Delete: instance ${id} not found in local state`);
      return;
    }
    // Mirror the Create flow: pop the same activity-log dialog, drive the
    // STEP_MARKERS by polling /instances/jobs/:id, and refresh on success.
    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting decommission job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'proxy', label: `Phase 5 — removing central Nginx vhost for ${instance.domain}`, status: 'pending' },
      { key: 'container', label: `Phase 1 — destroying LXC ${instance.vmid} on ${instance.node}`, status: 'pending' },
      { key: 'postgres', label: 'Phase 3 — dropping database (if remote)', status: 'pending' },
      { key: 'finalize', label: 'Finalizing decommission', status: 'pending' },
    ];
    setProvisionInstanceName(`${instance.name} (decommission)`);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(`Starting decommission for "${instance.name}".`);

    // Build payload from saved settings + the persisted instance record.
    const settings = settingsService.load();
    const pm = settings.proxmox;
    const dhis2Cfg = settings.dhis2;
    const p = settings.proxy;
    const remotePgHost = (instance.database.host ?? dhis2Cfg.postgresHost ?? '').trim();
    const dropDb =
      remotePgHost.length > 0 &&
      !['localhost', '127.0.0.1', '::1', 'postgres'].includes(remotePgHost);

    const payload = {
      skipProxyCleanup: false,
      dropDatabase: dropDb,
      database: {
        name: instance.database.name,
        user: instance.database.user,
        host: remotePgHost || undefined,
        port:
          instance.database.port ??
          (remotePgHost ? dhis2Cfg.postgresPort : undefined),
      },
      databaseAdmin: dropDb
        ? {
            user: dhis2Cfg.postgresAdminUser || 'postgres',
            password: dhis2Cfg.postgresAdminPassword || '',
          }
        : undefined,
      proxy: (() => {
        const fields: {
          host?: string;
          sshPort?: number;
          sshUser?: string;
          sshKeyPath?: string;
          nginxConfigPath?: string;
          nginxReloadCommand?: string;
        } = {};
        const host = (p.host ?? '').trim();
        const sshUser = (p.sshUser ?? '').trim();
        const sshKeyPath = (p.sshKeyPath ?? '').trim();
        const nginxConfigPath = (p.nginxConfigPath ?? '').trim();
        const nginxReloadCommand = (p.nginxReloadCommand ?? '').trim();
        if (host) fields.host = host;
        if (Number.isInteger(p.sshPort) && p.sshPort > 0) {
          fields.sshPort = p.sshPort;
        }
        if (sshUser) fields.sshUser = sshUser;
        if (sshKeyPath) fields.sshKeyPath = sshKeyPath;
        if (nginxConfigPath) fields.nginxConfigPath = nginxConfigPath;
        if (nginxReloadCommand) fields.nginxReloadCommand = nginxReloadCommand;
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
      proxmox: (() => {
        const apiUrl = (pm.apiUrl ?? '').trim();
        const tokenId = (pm.tokenId ?? '').trim();
        const tokenSecret = (pm.tokenSecret ?? '').trim();
        const username = (pm.username ?? '').trim();
        const fields: {
          apiUrl?: string;
          apiUser?: string;
          apiTokenId?: string;
          apiTokenSecret?: string;
          validateApiCerts?: boolean;
        } = {};
        if (apiUrl) fields.apiUrl = apiUrl;
        if (pm.authMethod === 'token') {
          if (tokenId) fields.apiTokenId = tokenId;
          if (tokenSecret) fields.apiTokenSecret = tokenSecret;
          if (!tokenId.includes('!') && username) fields.apiUser = username;
        }
        fields.validateApiCerts = Boolean(pm.verifyTls);
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
    };

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startDecommissionJob(
        baseUrl,
        id,
        payload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);

      let lastLineCount = 0;
      const deadline = Date.now() + 30 * 60 * 1000; // 30 minutes
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
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
          if (job.lines.length > 0) advanceSteps('proxy');
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
            `Instance "${instance.name}" decommissioned successfully (exit 0).`,
          );
          loadInstances();
          break;
        }
        const message =
          job.error ?? `Decommission failed (exit ${job.exitCode ?? '?'})`;
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
      console.error('Failed to decommission instance:', error);
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

  const handleEditInstance = async (
    instance: DHIS2Instance,
    draft: {
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
    },
  ) => {
    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting edit job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'resize', label: `Phase 1 — resize LXC ${instance.vmid} on ${instance.node}`, status: 'pending' },
      { key: 'dhis2config', label: 'Phase 2 — re-render dhis.conf in LXC', status: 'pending' },
      { key: 'restart', label: 'Phase 2 — restart Tomcat', status: 'pending' },
      { key: 'finalize', label: 'Finalizing edit', status: 'pending' },
    ];
    setProvisionInstanceName(`${instance.name} (edit)`);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(`Starting edit for "${instance.name}".`);

    const settings = settingsService.load();
    const pm = settings.proxmox;
    const p = settings.proxy;
    const dbHost = draft.dbHost?.trim() || (settings.dhis2.postgresHost ?? '').trim() || 'localhost';
    const dbPort = Number.isInteger(draft.dbPort) && draft.dbPort > 0
      ? draft.dbPort
      : settings.dhis2.postgresPort || 5432;

    const payload = {
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
        host: dbHost,
        port: dbPort,
        password: draft.dbPassword,
      },
      restartTomcat: true,
      proxy: (() => {
        const fields: {
          host?: string;
          sshPort?: number;
          sshUser?: string;
          sshKeyPath?: string;
        } = {};
        const host = (p.host ?? '').trim();
        const sshUser = (p.sshUser ?? '').trim();
        const sshKeyPath = (p.sshKeyPath ?? '').trim();
        if (host) fields.host = host;
        if (Number.isInteger(p.sshPort) && p.sshPort > 0) {
          fields.sshPort = p.sshPort;
        }
        if (sshUser) fields.sshUser = sshUser;
        if (sshKeyPath) fields.sshKeyPath = sshKeyPath;
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
      proxmox: (() => {
        const apiUrl = (pm.apiUrl ?? '').trim();
        const tokenId = (pm.tokenId ?? '').trim();
        const tokenSecret = (pm.tokenSecret ?? '').trim();
        const username = (pm.username ?? '').trim();
        const fields: {
          apiUrl?: string;
          apiUser?: string;
          apiTokenId?: string;
          apiTokenSecret?: string;
          validateApiCerts?: boolean;
        } = {};
        if (apiUrl) fields.apiUrl = apiUrl;
        if (pm.authMethod === 'token') {
          if (tokenId) fields.apiTokenId = tokenId;
          if (tokenSecret) fields.apiTokenSecret = tokenSecret;
          if (!tokenId.includes('!') && username) fields.apiUser = username;
        }
        fields.validateApiCerts = Boolean(pm.verifyTls);
        return Object.keys(fields).length > 0 ? fields : undefined;
      })(),
    };

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startEditJob(
        baseUrl,
        instance.id,
        payload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);

      let lastLineCount = 0;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
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
          if (job.lines.length > 0) advanceSteps('resize');
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
            `Instance "${draft.name}" edited successfully (exit 0).`,
          );
          loadInstances();
          break;
        }
        const message = job.error ?? `Edit failed (exit ${job.exitCode ?? '?'})`;
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
      console.error('Failed to update instance:', error);
      const message = error instanceof Error ? error.message : String(error);
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

  const handleOpenClone = async (instance: DHIS2Instance) => {
    setCloneDialog({
      open: true,
      source: instance,
      suggestedVmid: null,
      submitting: false,
      error: null,
    });
    // Best-effort suggested VMID — fall back to source vmid + 1 if the
    // backend can't reach Proxmox right now.
    try {
      const next = await dhis2Service.getNextVmid();
      setCloneDialog(prev => ({ ...prev, suggestedVmid: next }));
    } catch {
      const fallback = Number(instance.vmid);
      setCloneDialog(prev => ({
        ...prev,
        suggestedVmid: Number.isFinite(fallback) ? fallback + 1 : null,
      }));
    }
  };

  const handleCloneInstance = async (payload: CloneInstancePayload) => {
    const source = cloneDialog.source;
    if (!source) return;

    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting clone job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'clone', label: `Phase 3 — clone LXC ${source.vmid} -> ${payload.vmid} on ${payload.node}`, status: 'pending' },
      { key: 'cloneDb', label: `Phase 5b — clone database (strategy: ${payload.dbStrategy})`, status: 'pending' },
      { key: 'dhis2config', label: 'Phase 6 — re-render dhis.conf inside cloned LXC', status: 'pending' },
      { key: 'restart', label: 'Phase 6 — restart Tomcat', status: 'pending' },
      { key: 'proxy', label: `Phase 7 — central Nginx vhost for ${payload.domain}`, status: 'pending' },
      { key: 'finalize', label: 'Finalizing clone', status: 'pending' },
    ];

    setProvisionInstanceName(`${payload.name} (clone of ${source.name})`);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(
      `Starting clone of "${source.name}" -> "${payload.name}" (db_strategy=${payload.dbStrategy}).`,
    );

    // Layer global settings (proxy + proxmox) onto the dialog payload so
    // the backend doesn't have to fall back to defaults.
    const settings = settingsService.load();
    const pm = settings.proxmox;
    const p = settings.proxy;
    const enrichedPayload: CloneInstancePayload = {
      ...payload,
      email: payload.email || settings.proxy.letsencryptEmail || undefined,
      proxy: (() => {
        const merged = { ...(payload.proxy ?? {}) };
        const host = (p.host ?? '').trim();
        const sshUser = (p.sshUser ?? '').trim();
        const sshKeyPath = (p.sshKeyPath ?? '').trim();
        if (!merged.host && host) merged.host = host;
        if (
          merged.sshPort === undefined &&
          Number.isInteger(p.sshPort) &&
          p.sshPort > 0
        ) {
          merged.sshPort = p.sshPort;
        }
        if (!merged.sshUser && sshUser) merged.sshUser = sshUser;
        if (!merged.sshKeyPath && sshKeyPath) merged.sshKeyPath = sshKeyPath;
        return Object.keys(merged).length > 0 ? merged : undefined;
      })(),
      proxmox: (() => {
        const merged = { ...(payload.proxmox ?? {}) };
        const apiUrl = (pm.apiUrl ?? '').trim();
        const tokenId = (pm.tokenId ?? '').trim();
        const tokenSecret = (pm.tokenSecret ?? '').trim();
        const username = (pm.username ?? '').trim();
        if (!merged.apiUrl && apiUrl) merged.apiUrl = apiUrl;
        if (pm.authMethod === 'token') {
          if (!merged.apiTokenId && tokenId) merged.apiTokenId = tokenId;
          if (!merged.apiTokenSecret && tokenSecret) {
            merged.apiTokenSecret = tokenSecret;
          }
          if (
            !merged.apiUser &&
            !tokenId.includes('!') &&
            username
          ) {
            merged.apiUser = username;
          }
        }
        if (merged.validateApiCerts === undefined) {
          merged.validateApiCerts = Boolean(pm.verifyTls);
        }
        return Object.keys(merged).length > 0 ? merged : undefined;
      })(),
    };

    // Close the dialog once the job is accepted so the activity log can
    // take over. Surface any submit error inline first.
    setCloneDialog(prev => ({ ...prev, submitting: true, error: null }));

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startCloneJob(
        baseUrl,
        source.id,
        enrichedPayload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);
      setCloneDialog(prev => ({ ...prev, open: false, submitting: false }));

      const CLONE_STEP_MARKERS: Array<{ pattern: RegExp; advanceTo: string }> = [
        { pattern: /PLAY \[Phase 3 — clone LXC/i, advanceTo: 'clone' },
        { pattern: /PLAY \[Phase 5b — clone DB|CREATE DATABASE/i, advanceTo: 'cloneDb' },
        { pattern: /PLAY \[Phase 6 — apply DHIS2 config|Push dhis\.conf into LXC/i, advanceTo: 'dhis2config' },
        { pattern: /Restart Tomcat inside LXC|systemctl restart tomcat/i, advanceTo: 'restart' },
        { pattern: /PLAY \[Phase 7[ab]?\b|TASK \[proxy\s*:/i, advanceTo: 'proxy' },
        { pattern: /STEP_DONE: clone vmid=/i, advanceTo: 'finalize' },
      ];

      let lastLineCount = 0;
      const deadline = Date.now() + 60 * 60 * 1000;
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
        if (job.lines.length > lastLineCount) {
          for (let i = lastLineCount; i < job.lines.length; i++) {
            const line = job.lines[i];
            appendProvisionLog(line);
            for (const m of CLONE_STEP_MARKERS) {
              if (m.pattern.test(line)) advanceSteps(m.advanceTo);
            }
          }
          lastLineCount = job.lines.length;
        }
        if (job.status === 'running' || job.status === 'queued') {
          if (job.lines.length > 0) advanceSteps('clone');
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
            `Clone "${payload.name}" completed successfully (exit 0).`,
          );
          loadInstances();
          break;
        }
        const message =
          job.error ?? `Clone failed (exit ${job.exitCode ?? '?'})`;
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
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to clone instance:', error);
      setCloneDialog(prev => ({
        ...prev,
        submitting: false,
        error: message,
      }));
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

  const handleOpenUpgrade = (
    instance: DHIS2Instance,
    opts?: { defaultVersion?: string },
  ) => {
    setUpgradeDialog({
      open: true,
      instance,
      submitting: false,
      error: null,
      defaultVersion: opts?.defaultVersion,
    });
  };

  const handleUpgradeInstance = async (payload: UpgradeInstancePayload) => {
    const target = upgradeDialog.instance;
    if (!target) return;

    const steps: ProvisionStep[] = [
      { key: 'submit', label: 'Submitting upgrade job to backend', status: 'pending' },
      { key: 'connect', label: 'Connecting to orchestrator host', status: 'pending' },
      { key: 'preflight', label: `Phase 1 — pre-flight checks on LXC ${target.vmid}`, status: 'pending' },
      {
        key: 'backup',
        label:
          payload.backupDb === false
            ? 'Phase 2 — pg_dump backup (skipped)'
            : 'Phase 2 — pg_dump backup of current database',
        status: 'pending',
      },
      { key: 'stage', label: `Phase 3 — stage DHIS2 ${payload.toVersion} WAR on PVE host`, status: 'pending' },
      { key: 'swap', label: 'Phase 4 — stop Tomcat, archive current WAR, push new WAR', status: 'pending' },
      { key: 'health', label: 'Phase 5 — restart Tomcat and health-check DHIS2', status: 'pending' },
      { key: 'finalize', label: 'Finalizing upgrade', status: 'pending' },
    ];

    setProvisionInstanceName(`${target.name} upgrade -> ${payload.toVersion}`);
    setProvisionSteps(steps);
    setProvisionLog([]);
    setProvisionError(null);
    setProvisionDone(false);
    setProvisionOpen(true);
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayIndex(0);
    setAutoScroll(true);
    appendProvisionLog(
      `Starting upgrade of "${target.name}" -> DHIS2 ${payload.toVersion}.`,
    );

    // Layer global settings (proxy + proxmox) onto the dialog payload.
    const settings = settingsService.load();
    const pm = settings.proxmox;
    const p = settings.proxy;
    const enrichedPayload: UpgradeInstancePayload = {
      ...payload,
      proxy: (() => {
        const merged = { ...(payload.proxy ?? {}) };
        const host = (p.host ?? '').trim();
        const sshUser = (p.sshUser ?? '').trim();
        const sshKeyPath = (p.sshKeyPath ?? '').trim();
        if (!merged.host && host) merged.host = host;
        if (
          merged.sshPort === undefined &&
          Number.isInteger(p.sshPort) &&
          p.sshPort > 0
        ) {
          merged.sshPort = p.sshPort;
        }
        if (!merged.sshUser && sshUser) merged.sshUser = sshUser;
        if (!merged.sshKeyPath && sshKeyPath) merged.sshKeyPath = sshKeyPath;
        return Object.keys(merged).length > 0 ? merged : undefined;
      })(),
      proxmox: (() => {
        const merged = { ...(payload.proxmox ?? {}) };
        const apiUrl = (pm.apiUrl ?? '').trim();
        const tokenId = (pm.tokenId ?? '').trim();
        const tokenSecret = (pm.tokenSecret ?? '').trim();
        const username = (pm.username ?? '').trim();
        if (!merged.apiUrl && apiUrl) merged.apiUrl = apiUrl;
        if (pm.authMethod === 'token') {
          if (!merged.apiTokenId && tokenId) merged.apiTokenId = tokenId;
          if (!merged.apiTokenSecret && tokenSecret) {
            merged.apiTokenSecret = tokenSecret;
          }
          if (!merged.apiUser && !tokenId.includes('!') && username) {
            merged.apiUser = username;
          }
        }
        if (merged.validateApiCerts === undefined) {
          merged.validateApiCerts = Boolean(pm.verifyTls);
        }
        return Object.keys(merged).length > 0 ? merged : undefined;
      })(),
    };

    setUpgradeDialog(prev => ({ ...prev, submitting: true, error: null }));

    try {
      updateStep('submit', 'running');
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const { jobId } = await dhis2Service.startUpgradeJob(
        baseUrl,
        target.id,
        enrichedPayload,
        backstageFetch,
      );
      updateStep('submit', 'done');
      updateStep('connect', 'running');
      appendProvisionLog(`Backend accepted job ${jobId}. Streaming progress…`);
      setUpgradeDialog(prev => ({ ...prev, open: false, submitting: false }));

      const UPGRADE_STEP_MARKERS: Array<{ pattern: RegExp; advanceTo: string }> = [
        { pattern: /PLAY \[Phase 1 — pre-flight upgrade/i, advanceTo: 'preflight' },
        { pattern: /PLAY \[Phase 2 — (run )?pg_dump|pg_dump '/i, advanceTo: 'backup' },
        { pattern: /PLAY \[Phase 3 — stage|Download WAR from|Copy pre-staged WAR/i, advanceTo: 'stage' },
        { pattern: /PLAY \[Phase 4 — swap|Stop Tomcat|Push new WAR/i, advanceTo: 'swap' },
        { pattern: /PLAY \[Phase 5 — health-check|Poll Tomcat for upgraded/i, advanceTo: 'health' },
        { pattern: /STEP_DONE: upgrade vmid=/i, advanceTo: 'finalize' },
      ];

      let lastLineCount = 0;
      const deadline = Date.now() + 60 * 60 * 1000;
      while (Date.now() < deadline) {
        await wait(1500);
        const job = await dhis2Service.getProvisionJob(
          baseUrl,
          jobId,
          backstageFetch,
        );
        if (job.lines.length > lastLineCount) {
          for (let i = lastLineCount; i < job.lines.length; i++) {
            const line = job.lines[i];
            appendProvisionLog(line);
            for (const m of UPGRADE_STEP_MARKERS) {
              if (m.pattern.test(line)) advanceSteps(m.advanceTo);
            }
          }
          lastLineCount = job.lines.length;
        }
        if (job.status === 'running' || job.status === 'queued') {
          if (job.lines.length > 0) advanceSteps('preflight');
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
            `Upgrade of "${target.name}" -> ${payload.toVersion} completed successfully (exit 0).`,
          );
          loadInstances();
          break;
        }
        const message =
          job.error ?? `Upgrade failed (exit ${job.exitCode ?? '?'})`;
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
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to upgrade instance:', error);
      setUpgradeDialog(prev => ({
        ...prev,
        submitting: false,
        error: message,
      }));
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

  const buildLogsProxyOverrides = () => {
    const p = settingsService.load().proxy;
    const fields: {
      host?: string;
      sshPort?: number;
      sshUser?: string;
      sshKeyPath?: string;
    } = {};
    const host = (p.host ?? '').trim();
    const sshUser = (p.sshUser ?? '').trim();
    const sshKeyPath = (p.sshKeyPath ?? '').trim();
    if (host) fields.host = host;
    if (Number.isInteger(p.sshPort) && p.sshPort > 0) {
      fields.sshPort = p.sshPort;
    }
    if (sshUser) fields.sshUser = sshUser;
    if (sshKeyPath) fields.sshKeyPath = sshKeyPath;
    return Object.keys(fields).length > 0 ? fields : undefined;
  };

  const loadInstanceLogs = async (
    instance: DHIS2Instance,
    source: 'auto' | 'dhis2' | 'catalina',
  ): Promise<{ lines: string[]; path?: string; error?: string }> => {
    try {
      const baseUrl = await discoveryApi.getBaseUrl('dhis2');
      const result = await dhis2Service.getInstanceLogs(
        baseUrl,
        instance.id,
        { source, lines: 200, proxy: buildLogsProxyOverrides() },
        backstageFetch,
      );
      return { lines: result.lines, path: result.path };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error('Failed to load instance logs:', error);
      return {
        lines: [`Failed to load logs: ${message}`],
        error: message,
      };
    }
  };

  const handleViewInstanceLogs = async (instance: DHIS2Instance) => {
    setLogsDialog({
      open: true,
      instance,
      lines: [],
      loading: true,
      source: 'auto',
    });
    const { lines, path, error } = await loadInstanceLogs(instance, 'auto');
    setLogsDialog(prev => ({
      ...prev,
      lines,
      path,
      error,
      loading: false,
    }));
  };

  const refreshInstanceLogs = async (
    nextSource?: 'auto' | 'dhis2' | 'catalina',
  ) => {
    if (!logsDialog.instance) return;
    const source = nextSource ?? logsDialog.source;
    setLogsDialog(prev => ({ ...prev, loading: true, source }));
    const { lines, path, error } = await loadInstanceLogs(
      logsDialog.instance,
      source,
    );
    setLogsDialog(prev => ({
      ...prev,
      lines,
      path,
      error,
      loading: false,
    }));
  };

  const closeLogsDialog = () =>
    setLogsDialog({
      open: false,
      instance: null,
      lines: [],
      loading: false,
      source: 'auto',
    });



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
            <Tab label="DHIS2 Instances" />
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
              onEdit={handleEditInstance}
              onClone={handleOpenClone}
              onUpgrade={handleOpenUpgrade}
              onChanged={loadInstances}
              unmanagedContainers={unmanagedContainers}
              reconcileWarning={reconcileWarning}
              clusterNodes={nodes.map(n => n.node)}
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

          {/* Logs Tab */}
          <TabPanel value={tabValue} index={2}>
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
                onClick={() => refreshInstanceLogs()}
                disabled={logsDialog.loading}
                title="Refresh"
              >
                <RefreshIcon />
              </IconButton>
            </Box>
          </DialogTitle>
          <DialogContent dividers>
            <Box
              display="flex"
              alignItems="center"
              flexWrap="wrap"
              mb={1}
              style={{ gap: 8 }}
            >
              <Typography variant="caption" color="textSecondary">
                Source:
              </Typography>
              {(['auto', 'dhis2', 'catalina'] as const).map(opt => (
                <Button
                  key={opt}
                  size="small"
                  variant={logsDialog.source === opt ? 'contained' : 'outlined'}
                  color={logsDialog.source === opt ? 'primary' : 'default'}
                  disabled={logsDialog.loading}
                  onClick={() => refreshInstanceLogs(opt)}
                  style={{ textTransform: 'none', minWidth: 0 }}
                >
                  {opt === 'auto'
                    ? 'Auto'
                    : opt === 'dhis2'
                    ? 'dhis.log'
                    : 'catalina.out'}
                </Button>
              ))}
              {logsDialog.path && !logsDialog.loading ? (
                <Typography
                  variant="caption"
                  color="textSecondary"
                  style={{ marginLeft: 'auto' }}
                >
                  {logsDialog.path}
                </Typography>
              ) : null}
            </Box>
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

        {/* Create Instance Dialog (extracted to CreateInstanceDialog.tsx).
            The provisioning-progress dialog below stacks on top of this one
            while a job runs, so the form values remain available for retry
            if anything fails. `key` is bumped after a successful run to
            reset the form on the next open. */}
        <CreateInstanceDialog
          key={createDialogKey}
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
            {provisionLog.length > 0 && (() => {
              // What the operator currently sees in the Paper.
              const displayedLog = replayActive
                ? lastRunLog.slice(0, replayIndex)
                : provisionLog;
              const replaySource = lastRunLog.length > 0 ? lastRunLog : provisionLog;
              const runFinished = provisionDone || provisionError !== null;
              const canReplay = runFinished && replaySource.length > 0;
              const cycleSpeed = () => {
                setReplaySpeed(prev =>
                  prev === 50 ? 25 : prev === 25 ? 10 : 50,
                );
              };
              const speedLabel =
                replaySpeed === 50 ? '1x' : replaySpeed === 25 ? '2x' : '4x';
              const startReplay = () => {
                setReplayActive(true);
                setReplayIndex(0);
                setReplayPlaying(true);
                setAutoScroll(true);
              };
              const resumeReplay = () => setReplayPlaying(true);
              const pauseReplay = () => setReplayPlaying(false);
              const stopReplay = () => {
                setReplayPlaying(false);
                setReplayActive(false);
                setReplayIndex(0);
                setAutoScroll(true);
              };
              const handleScroll = () => {
                const el = logScrollRef.current;
                if (!el) return;
                const nearBottom =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                setAutoScroll(nearBottom);
              };
              const jumpToBottom = () => {
                setAutoScroll(true);
                const el = logScrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              };
              const copyText = displayedLog.join('\n');
              return (
              <Box mt={2}>
                <Box
                  display="flex"
                  alignItems="center"
                  justifyContent="space-between"
                  mb={0.5}
                >
                  <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                    <Typography variant="caption" color="textSecondary">
                      Activity log
                    </Typography>
                    {replayActive && (
                      <Typography
                        variant="caption"
                        style={{
                          color: '#c084fc',
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                        }}
                      >
                        Replay {replayIndex}/{replaySource.length}
                      </Typography>
                    )}
                    {!replayActive && !autoScroll && (
                      <Typography
                        variant="caption"
                        style={{ color: '#fbbf24' }}
                      >
                        Auto-scroll paused
                      </Typography>
                    )}
                  </Box>
                  <Box display="flex" alignItems="center">
                    {!replayActive && !autoScroll && (
                      <Tooltip title="Jump to latest">
                        <IconButton size="small" onClick={jumpToBottom} aria-label="Jump to latest log line">
                          <VerticalAlignBottomIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {canReplay && !replayActive && (
                      <Tooltip title="Replay this run">
                        <IconButton size="small" onClick={startReplay} aria-label="Replay activity log">
                          <PlayArrowIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {replayActive && !replayPlaying && replayIndex < replaySource.length && (
                      <Tooltip title="Resume">
                        <IconButton size="small" onClick={resumeReplay} aria-label="Resume replay">
                          <PlayArrowIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {replayActive && replayPlaying && (
                      <Tooltip title="Pause">
                        <IconButton size="small" onClick={pauseReplay} aria-label="Pause replay">
                          <PauseIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {replayActive && replayIndex >= replaySource.length && (
                      <Tooltip title="Restart replay">
                        <IconButton size="small" onClick={startReplay} aria-label="Restart replay">
                          <ReplayIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {replayActive && (
                      <Tooltip title="Exit replay (back to live)">
                        <IconButton size="small" onClick={stopReplay} aria-label="Exit replay">
                          <StopIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {replayActive && (
                      <Tooltip title={`Playback speed: ${speedLabel} (click to cycle)`}>
                        <IconButton size="small" onClick={cycleSpeed} aria-label="Cycle replay speed">
                          <Box display="flex" alignItems="center" style={{ gap: 2 }}>
                            <SpeedIcon fontSize="small" />
                            <Typography variant="caption" style={{ fontWeight: 600 }}>
                              {speedLabel}
                            </Typography>
                          </Box>
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title={logCopied ? 'Copied!' : 'Copy logs'}>
                      <IconButton
                        size="small"
                        onClick={() => {
                          const text = copyText;
                          const fallback = () => {
                            try {
                              const ta = document.createElement('textarea');
                              ta.value = text;
                              ta.style.position = 'fixed';
                              ta.style.opacity = '0';
                              document.body.appendChild(ta);
                              ta.select();
                              document.execCommand('copy');
                              document.body.removeChild(ta);
                            } catch {
                              /* ignore */
                            }
                          };
                          const done = () => {
                            setLogCopied(true);
                            window.setTimeout(() => setLogCopied(false), 1500);
                          };
                          if (
                            navigator.clipboard &&
                            typeof navigator.clipboard.writeText === 'function'
                          ) {
                            navigator.clipboard
                              .writeText(text)
                              .then(done)
                              .catch(() => {
                                fallback();
                                done();
                              });
                          } else {
                            fallback();
                            done();
                          }
                        }}
                        aria-label="Copy activity log"
                      >
                        <FileCopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
                <Paper
                  variant="outlined"
                  ref={logScrollRef as React.Ref<HTMLDivElement>}
                  onScroll={handleScroll}
                  style={{
                    maxHeight: 280,
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
                  {(() => {
                    const groups = groupLogByPhase(displayedLog);
                    // The currently-running phase is whichever group was
                    // appended last. We render a single sticky banner at
                    // the top of the scrolling pane so the user always
                    // sees the active phase regardless of which group's
                    // <Box> currently intersects the viewport. Per-group
                    // headers below are kept (non-sticky) purely as
                    // section demarcators in the scroll history.
                    const activePhase: LogPhase =
                      groups.length > 0
                        ? groups[groups.length - 1].phase
                        : 'Submit';
                    const activeColor = PHASE_COLORS[activePhase];
                    return (
                      <>
                        <Box
                          style={{
                            position: 'sticky',
                            top: -8,
                            zIndex: 1,
                            marginLeft: -8,
                            marginRight: -8,
                            marginTop: -8,
                            paddingLeft: 8,
                            paddingRight: 8,
                            paddingTop: 6,
                            paddingBottom: 6,
                            marginBottom: 6,
                            background: '#0e1116',
                            borderBottom: `2px solid ${activeColor}`,
                            color: activeColor,
                            fontWeight: 700,
                            fontSize: 11,
                            letterSpacing: 0.5,
                            textTransform: 'uppercase',
                          }}
                        >
                          {phaseLabel(activePhase)}
                          {!provisionDone && !provisionError && ' — running…'}
                        </Box>
                        {groups.map((group, gIdx) => {
                          const color = PHASE_COLORS[group.phase];
                          return (
                            <Box
                              key={gIdx}
                              mb={1}
                              style={{
                                borderLeft: `3px solid ${color}`,
                                paddingLeft: 8,
                              }}
                            >
                              <Box
                                style={{
                                  color,
                                  fontWeight: 600,
                                  fontSize: 11,
                                  letterSpacing: 0.5,
                                  textTransform: 'uppercase',
                                  marginBottom: 2,
                                  paddingTop: 2,
                                  paddingBottom: 2,
                                }}
                              >
                                {phaseLabel(group.phase)}
                              </Box>
                              {group.lines.map((line, lIdx) => (
                                <div
                                  key={lIdx}
                                  style={{
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    color:
                                      group.phase === 'Error'
                                        ? '#fca5a5'
                                        : undefined,
                                  }}
                                >
                                  {line}
                                </div>
                              ))}
                            </Box>
                          );
                        })}
                      </>
                    );
                  })()}
                </Paper>
              </Box>
              );
            })()}
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

        {/* Clone-to-new-environment for an existing instance */}
        <CloneInstanceDialog
          open={cloneDialog.open}
          source={cloneDialog.source}
          clusterNodes={nodes.map(n => n.node)}
          versions={versions}
          suggestedVmid={cloneDialog.suggestedVmid}
          baseDomain={
            (settingsService.load().proxy.baseDomain ?? [])[0] ?? ''
          }
          submitting={cloneDialog.submitting}
          errorMessage={cloneDialog.error}
          onClose={() =>
            setCloneDialog({
              open: false,
              source: null,
              suggestedVmid: null,
              submitting: false,
              error: null,
            })
          }
          onSubmit={handleCloneInstance}
        />

        {/* Upgrade DHIS2 WAR for an existing instance */}
        <UpgradeInstanceDialog
          open={upgradeDialog.open}
          instance={upgradeDialog.instance}
          versions={versions}
          submitting={upgradeDialog.submitting}
          errorMessage={upgradeDialog.error}
          defaultVersion={upgradeDialog.defaultVersion}
          onClose={() =>
            setUpgradeDialog({
              open: false,
              instance: null,
              submitting: false,
              error: null,
            })
          }
          onSubmit={handleUpgradeInstance}
        />
      </Content>
    </Page>
  );
};
