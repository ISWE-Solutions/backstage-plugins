import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Button,
  Chip,
  IconButton,
  Tooltip,
  makeStyles,
} from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import StopIcon from '@material-ui/icons/Stop';
import DeleteIcon from '@material-ui/icons/Delete';
import SettingsIcon from '@material-ui/icons/Settings';
import BuildIcon from '@material-ui/icons/Build';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import BackupIcon from '@material-ui/icons/Backup';
import { OdooInstance } from '../types';
import { OS_INFO } from '../odooConfig';

const useStyles = makeStyles(theme => ({
  instanceCard: {
    marginBottom: theme.spacing(2),
    borderLeft: `4px solid ${theme.palette.primary.main}`,
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
}));

export interface OdooInstancesPanelProps {
  instances: OdooInstance[];
  onCreateInstance: () => void;
  onStartInstance: (id: string) => void;
  onStopInstance: (id: string) => void;
  onDeleteInstance: (id: string) => void;
  onBackupInstance: (id: string) => void;
}

export const OdooInstancesPanel = (props: OdooInstancesPanelProps) => {
  const {
    instances,
    onCreateInstance,
    onStartInstance,
    onStopInstance,
    onDeleteInstance,
    onBackupInstance,
  } = props;
  const classes = useStyles();

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

  return (
    <Box>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        mb={2}
      >
        <Typography variant="h6">Odoo Instances</Typography>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddIcon />}
          onClick={onCreateInstance}
        >
          New Instance
        </Button>
      </Box>

      {instances.map(instance => (
        <Card key={instance.id} className={classes.instanceCard}>
          <CardContent>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <Box display="flex" alignItems="center" mb={1}>
                  <Typography variant="h6">{instance.name}</Typography>
                  {getStatusChip(instance.status)}
                </Box>
                <Typography variant="body2" color="textSecondary">
                  {instance.environment[0].toUpperCase() +
                    instance.environment.slice(1)}{' '}
                  · Odoo {instance.version} ({instance.edition}) on{' '}
                  {OS_INFO[instance.os].label}
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  Database: {instance.database.name} (
                  {instance.database.placement === 'cluster'
                    ? `${instance.database.cluster} cluster`
                    : 'local'}
                  )
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  Code: odoo@{instance.sources.community.revision}
                  {instance.sources.enterprise
                    ? `, enterprise@${instance.sources.enterprise.revision}`
                    : ''}
                  {instance.sources.addons.map(
                    a => `, ${a.name}@${a.revision}`,
                  )}
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  Domain: {instance.domain}
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  Node: {instance.node} | VMID: {instance.vmid}
                </Typography>
              </Grid>
              <Grid item xs={12} md={3}>
                <Typography variant="body2">
                  <strong>Resources:</strong>
                </Typography>
                <Typography variant="body2">
                  CPU: {instance.resources.cpu} cores
                </Typography>
                <Typography variant="body2">
                  Memory: {instance.resources.memory} MB
                </Typography>
                <Typography variant="body2">
                  Storage: {instance.resources.storage} GB
                </Typography>
                <Typography variant="body2">
                  Workers: {instance.config.workers}
                </Typography>
              </Grid>
              <Grid item xs={12} md={3}>
                <Box className={classes.actionButtons}>
                  {instance.status === 'stopped' ? (
                    <Tooltip title="Start">
                      <IconButton
                        color="primary"
                        onClick={() => onStartInstance(instance.id)}
                      >
                        <PlayArrowIcon />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Stop">
                      <IconButton
                        color="secondary"
                        onClick={() => onStopInstance(instance.id)}
                      >
                        <StopIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Backup">
                    <IconButton onClick={() => onBackupInstance(instance.id)}>
                      <BackupIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Clone">
                    <IconButton>
                      <FileCopyIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Settings">
                    <IconButton>
                      <SettingsIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      color="secondary"
                      onClick={() => onDeleteInstance(instance.id)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
                {instance.runbot_enabled && (
                  <Chip
                    icon={<BuildIcon />}
                    label="Runbot Enabled"
                    size="small"
                    color="primary"
                    style={{ marginTop: 8 }}
                  />
                )}
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      ))}
    </Box>
  );
};
