import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  Grid,
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
    minWidth: 160,
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

export const DHIS2LogsPanel = () => {
  const classes = useStyles();
  const [logs, setLogs] = useState<OrchestrationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [instanceFilter, setInstanceFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await dhis2Service.getOrchestrationLogs();
      // newest first
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

  const instanceOptions = useMemo(() => {
    const map = new Map<string, string>();
    logs.forEach(l => {
      if (l.instanceId) {
        map.set(l.instanceId, l.instanceName ?? l.instanceId);
      }
    });
    return Array.from(map.entries());
  }, [logs]);

  const actionOptions = useMemo(
    () => Array.from(new Set(logs.map(l => l.action))).sort(),
    [logs],
  );

  const filteredLogs = useMemo(() => {
    const minLevel = levelFilter === 'all' ? 0 : LEVEL_ORDER[levelFilter];
    const needle = search.trim().toLowerCase();
    return logs.filter(l => {
      if (LEVEL_ORDER[l.level] < minLevel) return false;
      if (instanceFilter !== 'all' && l.instanceId !== instanceFilter) return false;
      if (actionFilter !== 'all' && l.action !== actionFilter) return false;
      if (needle) {
        const hay = `${l.message} ${l.instanceName ?? ''} ${l.user ?? ''} ${l.taskId ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [logs, levelFilter, instanceFilter, actionFilter, search]);

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

        <FormControl size="small" variant="outlined" className={classes.filterField}>
          <InputLabel>Level</InputLabel>
          <Select
            label="Level"
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value as LogLevel | 'all')}
          >
            <MenuItem value="all">All levels</MenuItem>
            <MenuItem value="debug">Debug+</MenuItem>
            <MenuItem value="info">Info+</MenuItem>
            <MenuItem value="warn">Warn+</MenuItem>
            <MenuItem value="error">Error only</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" variant="outlined" className={classes.filterField}>
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

        <FormControl size="small" variant="outlined" className={classes.filterField}>
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

      <Grid container spacing={2} style={{ marginBottom: 8 }}>
        <Grid item>
          <Typography variant="body2" color="textSecondary">
            Showing {filteredLogs.length} of {logs.length} entries
          </Typography>
        </Grid>
      </Grid>

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
        <TableContainer component={Paper} variant="outlined" className={classes.tableWrap}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Timestamp</TableCell>
                <TableCell>Level</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Instance</TableCell>
                <TableCell>User</TableCell>
                <TableCell>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredLogs.map(entry => (
                <TableRow key={entry.id} hover>
                  <TableCell className={classes.monoCell}>
                    {new Date(entry.timestamp).toLocaleString()}
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
                  <TableCell className={classes.monoCell}>{entry.action}</TableCell>
                  <TableCell>{entry.instanceName ?? '—'}</TableCell>
                  <TableCell>{entry.user ?? '—'}</TableCell>
                  <TableCell className={classes.message}>
                    {entry.message}
                    {entry.taskId && (
                      <Typography variant="caption" display="block" color="textSecondary">
                        {entry.taskId}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};
