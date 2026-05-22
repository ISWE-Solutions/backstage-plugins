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
  DHIS2: '#34d399',
  Nginx: '#f472b6',
  Finalize: '#22d3ee',
  Error: '#f87171',
  General: '#6b7280',
};

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
    return prev;
  }

  // TASK lines reveal which role is currently running inside Phase 4.
  const taskMatch = raw.match(/TASK \[([a-zA-Z0-9_\-]+)\s*:/);
  if (taskMatch) {
    const role = taskMatch[1].toLowerCase();
    if (role === 'pve_lxc') return 'Proxmox';
    if (role === 'lxc_bootstrap') return 'Bootstrap';
    if (role === 'stage_restore') return 'Restore';
    if (role === 'common') return 'Common';
    if (role === 'postgres' || role === 'postgresql') return 'PostgreSQL';
    if (role === 'dhis2') return 'DHIS2';
    if (role === 'nginx') return 'Nginx';
    return prev;
  }

  // Wrapper / backend markers from provision-instance.sh and the backend.
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
        // Pull the reconciliation report so the panel can surface drift.
        // Failures are non-fatal — the panel just won't show the banner.
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
        // Backend unreachable — fall back to mock list.
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

  // Log-line markers from provision-instance.sh / Ansible output that we use
  // to advance the visible step list. Order matters: later matches "complete"
  // earlier steps.
  const STEP_MARKERS: Array<{ pattern: RegExp; advanceTo: string }> = [
    { pattern: /Phase 1 — creating LXC container/i, advanceTo: 'container' },
    { pattern: /container IP:/i, advanceTo: 'bootstrap' },
    { pattern: /PLAY \[Phase 2\b|TASK \[lxc_bootstrap\s*:/i, advanceTo: 'bootstrap' },
    { pattern: /Phase 2 — rendering inventory|running ansible-playbook/i, advanceTo: 'bootstrap' },
    { pattern: /TASK \[postgres\s*:/i, advanceTo: 'postgres' },
    { pattern: /TASK \[dhis2\s*:/i, advanceTo: 'dhis2' },
    // Phase 5 became an Ansible play (roles/proxy) instead of a shell-out
    // to configure-host-proxy.sh. Match the new play/task headers so the
    // UI advances to the 'proxy' step when Ansible reaches them; keep the
    // legacy patterns as fallbacks in case an older script is in use.
    { pattern: /PLAY \[Phase 5[ab]?\b|TASK \[proxy\s*:|Phase 3 — configuring central Nginx|TASK \[nginx\s*:/i, advanceTo: 'proxy' },
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

    // Steps modelled on provision-instance.sh / site.yml phases. Postgres
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

    // VMID and email come from saved settings — the script requires both.
    const settings = settingsService.load();
    const vmid = settings.proxmox.vmidStart || 200;
    const email = proxySettings.letsencryptEmail || settings.proxy.letsencryptEmail || 'admin@example.com';

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
      vmid,
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
      tomcatVersion: request.tomcatVersion,
      // Forward Proxmox API credentials from the ProxmoxClusterPanel saved
      // settings so the operator can override the server-side defaults
      // (PROXMOX_API_URL / PROXMOX_USER / PROXMOX_TOKEN_ID /
      // PROXMOX_TOKEN_SECRET) per-job. Only non-empty fields are sent —
      // anything blank falls back to the backend config / env vars.
      proxmox: (() => {
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
      })(),
      // Forward Reverse-Proxy panel settings so Phase 5's `proxy` role
      // SSHes to the dedicated proxy server (host, port, user, key)
      // and writes nginx configs to the operator-chosen directory using
      // the operator-chosen reload command. When a field is blank we
      // omit it so provision-instance.sh applies its fallback (PVE host
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
            <Tab label="DHIS2 Instances" />
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
                  {groupLogByPhase(displayedLog).map((group, gIdx) => {
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
                            position: 'sticky',
                            top: -8,
                            background: '#0e1116',
                            paddingTop: 2,
                            paddingBottom: 2,
                          }}
                        >
                          {group.phase}
                        </Box>
                        {group.lines.map((line, lIdx) => (
                          <div
                            key={lIdx}
                            style={{
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color:
                                group.phase === 'Error' ? '#fca5a5' : undefined,
                            }}
                          >
                            {line}
                          </div>
                        ))}
                      </Box>
                    );
                  })}
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
      </Content>
    </Page>
  );
};
