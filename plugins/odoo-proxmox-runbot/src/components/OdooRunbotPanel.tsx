import {
  Box,
  Typography,
  Button,
  Chip,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  makeStyles,
} from '@material-ui/core';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import RefreshIcon from '@material-ui/icons/Refresh';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import WarningIcon from '@material-ui/icons/Warning';
import ScheduleIcon from '@material-ui/icons/Schedule';
import CodeIcon from '@material-ui/icons/Code';
import { RunbotBuild, RunbotBranch } from '../types';

const useStyles = makeStyles(theme => ({
  sectionTitle: {
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
}));

export interface OdooRunbotPanelProps {
  branches: RunbotBranch[];
  builds: RunbotBuild[];
  onTriggerBuild: (branchId: number) => void;
  onKillBuild: (buildId: number) => void;
  onRebuildBuild: (buildId: number) => void;
}

export const OdooRunbotPanel = (props: OdooRunbotPanelProps) => {
  const { branches, builds, onTriggerBuild, onKillBuild, onRebuildBuild } =
    props;
  const classes = useStyles();

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

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <Box>
      <Typography variant="h6" className={classes.sectionTitle}>
        Runbot Branches and Builds
      </Typography>

      {branches.map(branch => (
        <Accordion key={branch.id}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box display="flex" alignItems="center" width="100%">
              <CodeIcon style={{ marginRight: 8 }} />
              <Typography style={{ flexGrow: 1 }}>
                {branch.repo_name} / {branch.name}
              </Typography>
              <Chip
                label={branch.state}
                size="small"
                color={branch.state === 'done' ? 'default' : 'primary'}
                style={{ marginRight: 8 }}
              />
              <Typography variant="body2" color="textSecondary">
                {branch.build_count} builds
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Box width="100%">
              <Box display="flex" justifyContent="flex-end" mb={2}>
                <Button
                  variant="outlined"
                  color="primary"
                  size="small"
                  startIcon={<PlayArrowIcon />}
                  onClick={() => onTriggerBuild(branch.id)}
                >
                  Trigger Build
                </Button>
              </Box>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Build</TableCell>
                      <TableCell>Commit</TableCell>
                      <TableCell>Author</TableCell>
                      <TableCell>State</TableCell>
                      <TableCell>Duration</TableCell>
                      <TableCell>Coverage</TableCell>
                      <TableCell>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {builds
                      .filter(b => b.branch_id === branch.id)
                      .slice(0, 5)
                      .map(build => (
                        <TableRow key={build.id}>
                          <TableCell>
                            <Box display="flex" alignItems="center">
                              {getBuildResultIcon(build.result, build.state)}
                              <Typography style={{ marginLeft: 8 }}>
                                #{build.id}
                              </Typography>
                            </Box>
                          </TableCell>
                          <TableCell>
                            <Tooltip title={build.commit_message}>
                              <Typography variant="body2">
                                {build.commit.substring(0, 8)}
                              </Typography>
                            </Tooltip>
                          </TableCell>
                          <TableCell>{build.author}</TableCell>
                          <TableCell>
                            <Chip label={build.state} size="small" />
                          </TableCell>
                          <TableCell>
                            {build.duration > 0
                              ? formatDuration(build.duration)
                              : '-'}
                          </TableCell>
                          <TableCell>
                            {build.coverage_result
                              ? `${build.coverage_result.toFixed(1)}%`
                              : '-'}
                          </TableCell>
                          <TableCell>
                            {(build.state === 'testing' ||
                              build.state === 'running') && (
                              <Tooltip title="Kill">
                                <IconButton
                                  size="small"
                                  onClick={() => onKillBuild(build.id)}
                                >
                                  <StopIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                            {build.result === 'ko' && (
                              <Tooltip title="Rebuild">
                                <IconButton
                                  size="small"
                                  onClick={() => onRebuildBuild(build.id)}
                                >
                                  <RefreshIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
};
