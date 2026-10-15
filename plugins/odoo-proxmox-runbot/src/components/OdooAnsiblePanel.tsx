import {
  Grid,
  Card,
  CardContent,
  Typography,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  ListItemIcon,
  Tooltip,
} from '@material-ui/core';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import AssessmentIcon from '@material-ui/icons/Assessment';
import { AnsiblePlaybook, AnsiblePlaybookExecution } from '../types';

export interface OdooAnsiblePanelProps {
  playbooks: AnsiblePlaybook[];
  executions: AnsiblePlaybookExecution[];
  onExecutePlaybook: (playbook: AnsiblePlaybook) => void;
}

export const OdooAnsiblePanel = (props: OdooAnsiblePanelProps) => {
  const { playbooks, executions, onExecutePlaybook } = props;

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} md={6}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Playbooks
            </Typography>
            <List>
              {playbooks.map(playbook => (
                <ListItem key={playbook.id} button>
                  <ListItemIcon>
                    <AssessmentIcon />
                  </ListItemIcon>
                  <ListItemText
                    primary={playbook.name}
                    secondary={playbook.description}
                  />
                  <ListItemSecondaryAction>
                    <Tooltip title="Run Playbook">
                      <IconButton
                        edge="end"
                        onClick={() => onExecutePlaybook(playbook)}
                      >
                        <PlayArrowIcon />
                      </IconButton>
                    </Tooltip>
                  </ListItemSecondaryAction>
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      </Grid>

      <Grid item xs={12} md={6}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Recent Executions
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Playbook</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Duration</TableCell>
                    <TableCell>Stats</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {executions.map(exec => (
                    <TableRow key={exec.id}>
                      <TableCell>{exec.playbook_name}</TableCell>
                      <TableCell>
                        <Chip
                          label={exec.status}
                          size="small"
                          color={
                            exec.status === 'success' ? 'primary' : 'default'
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {exec.duration ? formatDuration(exec.duration) : '-'}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption">
                          OK: {exec.stats.ok} | Changed: {exec.stats.changed} |
                          Failed: {exec.stats.failed}
                        </Typography>
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
};
