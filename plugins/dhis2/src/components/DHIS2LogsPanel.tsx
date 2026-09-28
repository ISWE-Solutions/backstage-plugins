import { Fragment, useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  makeStyles,
} from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import GetAppIcon from '@material-ui/icons/GetApp';
import KeyboardArrowDownIcon from '@material-ui/icons/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@material-ui/icons/KeyboardArrowRight';
import { LogLevel, OrchestrationLogEntry } from '../types';
import { dhis2Service } from '../services/dhis2Service';

const useStyles = makeStyles(theme => ({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
    marginBottom: theme.spacing(2),
  },
  filterField: {
    minWidth: 150,
  },
  summary: {
    display: 'flex',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
    marginBottom: theme.spacing(2),
  },
  tableWrap: {
    maxHeight: 600,
    overflow: 'auto',
  },
  monoCell: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap',
  },
  message: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  levelChip: {
    minWidth: 64,
    textTransform: 'uppercase',
    fontWeight: 600,
  },
  detail: {
    backgroundColor: theme.palette.background.default,
    padding: theme.spacing(2),
  },
  detailKey: {
    fontFamily: 'monospace',
    color: theme.palette.text.secondary,
    marginRight: theme.spacing(1),
  },
  detailPre: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  clickRow: {
    cursor: 'pointer',
  },
  empty: {
    textAlign: 'center',
    padding: theme.spacing(6),
  },
}));

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#90a4ae',
  info: '#1976d2',
  warn: '#f9a825',
  error: '#d32f2f',
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const AUTO_REFRESH_MS = 10_000;

type TimeRange = 'all' | '1h' | '24h' | '7d';
const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return iso;
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const COLSPAN = 7;

export const DHIS2LogsPanel = () => {
  const classes = useStyles();
  const [logs, setLogs] = useState<OrchestrationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [instanceFilter, setInstanceFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await dhis2Service.getOrchestrationLogs();
      data.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setLogs(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to load orchestration logs', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = window.setInterval(loadLogs, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadLogs]);

  const toggleRow = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const instanceOptions = useMemo(() => {
    const map = new Map<string, string>();
    logs.forEach(l => {
      if (l.instanceId) map.set(l.instanceId, l.instanceName ?? l.instanceId);
    });
    return Array.from(map.entries());
  }, [logs]);

  const actionOptions = useMemo(
    () => Array.from(new Set(logs.map(l => l.action))).sort(),
    [logs],
  );

  // Everything except the level filter — so the summary counts reflect the
  // current instance/action/search/time context, and clicking a level narrows.
  const preLevel = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const cutoff = timeRange === 'all' ? 0 : Date.now() - RANGE_MS[timeRange];
    return logs.filter(l => {
      if (cutoff && new Date(l.timestamp).getTime() < cutoff) return false;
      if (instanceFilter !== 'all' && l.instanceId !== instanceFilter)
        return false;
      if (actionFilter !== 'all' && l.action !== actionFilter) return false;
      if (needle) {
        const hay = `${l.message} ${l.instanceName ?? ''} ${l.user ?? ''} ${
          l.taskId ?? ''
        }`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [logs, instanceFilter, actionFilter, search, timeRange]);

  const counts = useMemo(() => {
    const c = { total: preLevel.length, debug: 0, info: 0, warn: 0, error: 0 };
    preLevel.forEach(l => {
      c[l.level] += 1;
    });
    return c;
  }, [preLevel]);

  const filteredLogs = useMemo(() => {
    if (levelFilter === 'all') return preLevel;
    const min = LEVEL_ORDER[levelFilter];
    return preLevel.filter(l => LEVEL_ORDER[l.level] >= min);
  }, [preLevel, levelFilter]);

  const handleExport = () => {
    const header = 'timestamp,level,action,instance,user,message\n';
    const rows = filteredLogs
      .map(l => {
        const msg = `"${l.message.replace(/"/g, '""')}"`;
        return [
          l.timestamp,
          l.level,
          l.action,
          l.instanceName ?? '',
          l.user ?? '',
          msg,
        ].join(',');
      })
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dhis2-orchestration-logs-${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const summaryChip = (
    label: string,
    value: LogLevel | 'all',
    count: number,
    color?: string,
  ) => (
    <Chip
      key={label}
      label={`${label}: ${count}`}
      onClick={() => setLevelFilter(value)}
      variant={levelFilter === value ? 'default' : 'outlined'}
      style={
        levelFilter === value && color
          ? { backgroundColor: color, color: '#fff' }
          : color
          ? { borderColor: color, color }
          : undefined
      }
    />
  );

  return (
    <Box>
      <Box className={classes.toolbar}>
        <Typography variant="h6" style={{ marginRight: 'auto' }}>
          Orchestration Logs
        </Typography>

        <TextField
          size="small"
          variant="outlined"
          label="Search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={classes.filterField}
        />

        <FormControl
          size="small"
          variant="outlined"
          className={classes.filterField}
        >
          <InputLabel>Time range</InputLabel>
          <Select
            label="Time range"
            value={timeRange}
            onChange={e => setTimeRange(e.target.value as TimeRange)}
          >
            <MenuItem value="all">All time</MenuItem>
            <MenuItem value="1h">Last hour</MenuItem>
            <MenuItem value="24h">Last 24 hours</MenuItem>
            <MenuItem value="7d">Last 7 days</MenuItem>
          </Select>
        </FormControl>

        <FormControl
          size="small"
          variant="outlined"
          className={classes.filterField}
        >
          <InputLabel>Instance</InputLabel>
          <Select
            label="Instance"
            value={instanceFilter}
            onChange={e => setInstanceFilter(e.target.value as string)}
          >
            <MenuItem value="all">All instances</MenuItem>
            {instanceOptions.map(([id, name]) => (
              <MenuItem key={id} value={id}>
                {name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl
          size="small"
          variant="outlined"
          className={classes.filterField}
        >
          <InputLabel>Action</InputLabel>
          <Select
            label="Action"
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value as string)}
          >
            <MenuItem value="all">All actions</MenuItem>
            {actionOptions.map(a => (
              <MenuItem key={a} value={a}>
                {a}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Switch
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              size="small"
            />
          }
          label="Auto-refresh"
        />

        <Tooltip title="Refresh">
          <IconButton onClick={loadLogs} color="primary" size="small">
            <RefreshIcon />
          </IconButton>
        </Tooltip>

        <Button
          variant="outlined"
          size="small"
          startIcon={<GetAppIcon />}
          onClick={handleExport}
          disabled={filteredLogs.length === 0}
        >
          Export CSV
        </Button>
      </Box>

      {/* Clickable severity summary — counts respect the other filters */}
      <Box className={classes.summary}>
        {summaryChip('All', 'all', counts.total)}
        {summaryChip('Errors', 'error', counts.error, LEVEL_COLORS.error)}
        {summaryChip('Warnings', 'warn', counts.warn, LEVEL_COLORS.warn)}
        {summaryChip('Info', 'info', counts.info, LEVEL_COLORS.info)}
        {summaryChip('Debug', 'debug', counts.debug, LEVEL_COLORS.debug)}
      </Box>

      <Typography
        variant="body2"
        color="textSecondary"
        style={{ marginBottom: 8 }}
      >
        Showing {filteredLogs.length} of {logs.length} entries
      </Typography>

      {loading && logs.length === 0 ? (
        <Box display="flex" justifyContent="center" p={4}>
          <CircularProgress />
        </Box>
      ) : filteredLogs.length === 0 ? (
        <Paper variant="outlined" className={classes.empty}>
          <Typography variant="body2" color="textSecondary">
            No log entries match the current filters.
          </Typography>
        </Paper>
      ) : (
        <TableContainer
          component={Paper}
          variant="outlined"
          className={classes.tableWrap}
        >
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Timestamp</TableCell>
                <TableCell>Level</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Instance</TableCell>
                <TableCell>User</TableCell>
                <TableCell>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredLogs.map(entry => {
                const isOpen = expanded.has(entry.id);
                const hasDetail =
                  Boolean(entry.taskId) ||
                  Boolean(entry.instanceId) ||
                  Boolean(
                    entry.details && Object.keys(entry.details).length > 0,
                  );
                return (
                  <Fragment key={entry.id}>
                    <TableRow
                      hover
                      className={hasDetail ? classes.clickRow : undefined}
                      onClick={
                        hasDetail ? () => toggleRow(entry.id) : undefined
                      }
                    >
                      <TableCell padding="checkbox">
                        {hasDetail && (
                          <IconButton size="small" aria-label="Toggle details">
                            {isOpen ? (
                              <KeyboardArrowDownIcon fontSize="small" />
                            ) : (
                              <KeyboardArrowRightIcon fontSize="small" />
                            )}
                          </IconButton>
                        )}
                      </TableCell>
                      <TableCell className={classes.monoCell}>
                        <Tooltip
                          title={new Date(entry.timestamp).toLocaleString()}
                        >
                          <span>{relativeTime(entry.timestamp)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={entry.level}
                          size="small"
                          className={classes.levelChip}
                          style={{
                            backgroundColor: LEVEL_COLORS[entry.level],
                            color: '#fff',
                          }}
                        />
                      </TableCell>
                      <TableCell className={classes.monoCell}>
                        {entry.action}
                      </TableCell>
                      <TableCell>{entry.instanceName ?? '—'}</TableCell>
                      <TableCell>{entry.user ?? '—'}</TableCell>
                      <TableCell className={classes.message}>
                        {entry.message}
                      </TableCell>
                    </TableRow>
                    {hasDetail && (
                      <TableRow>
                        <TableCell
                          colSpan={COLSPAN}
                          style={{ paddingTop: 0, paddingBottom: 0 }}
                        >
                          <Collapse in={isOpen} timeout="auto" unmountOnExit>
                            <Box className={classes.detail}>
                              {entry.taskId && (
                                <Typography variant="body2">
                                  <span className={classes.detailKey}>
                                    Proxmox task:
                                  </span>
                                  {entry.taskId}
                                </Typography>
                              )}
                              {entry.instanceId && (
                                <Typography variant="body2">
                                  <span className={classes.detailKey}>
                                    Instance id:
                                  </span>
                                  {entry.instanceId}
                                </Typography>
                              )}
                              {entry.details &&
                                Object.keys(entry.details).length > 0 && (
                                  <>
                                    <Typography
                                      variant="caption"
                                      className={classes.detailKey}
                                    >
                                      Details
                                    </Typography>
                                    <pre className={classes.detailPre}>
                                      {JSON.stringify(entry.details, null, 2)}
                                    </pre>
                                  </>
                                )}
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};
