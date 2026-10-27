import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  IconButton,
  Link,
  MenuItem,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import RefreshIcon from '@material-ui/icons/Refresh';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import { useApi } from '@backstage/core-plugin-api';
import {
  BuildExecutor,
  RunbotBatch,
  RunbotBuildSummary,
  RunbotBundle,
  RunbotHost,
  RunbotProject,
} from '@iswesolutions/plugin-odoo-runbot-common';
import { ProjectDetails, runbotApiRef } from '../../api/runbotApi';
import { BuildDialog } from './BuildDialog';
import { AddRepositoryDialog, NewProjectDialog } from './ConfigDialogs';
import {
  BuildChip,
  RESULT_COLORS,
  ago,
  duration,
  githubCommitUrl,
  githubPrUrl,
  githubTreeUrl,
  shortSha,
  stateLabel,
} from './common';

const BatchLine = ({
  batch,
  onOpenBuild,
}: {
  batch: RunbotBatch;
  onOpenBuild: (id: number) => void;
}) => (
  <Box>
    <Box>
      {batch.slots.map(s =>
        s.build ? (
          <BuildChip
            key={s.triggerId}
            build={s.build}
            onClick={() => onOpenBuild(s.build!.id)}
          />
        ) : (
          <Tooltip key={s.triggerId} title={s.skipReason ?? 'Waiting'}>
            <Chip
              size="small"
              variant="outlined"
              label={s.triggerName}
              style={{ margin: 2, opacity: 0.6 }}
            />
          </Tooltip>
        ),
      )}
      {batch.state === 'preparing' && (
        <Chip
          size="small"
          label="gathering commits"
          variant="outlined"
          style={{ margin: 2 }}
        />
      )}
    </Box>
    <Typography variant="caption" color="textSecondary">
      {batch.commits.map((c, i) => (
        <span key={c.repoId}>
          {i > 0 && ' · '}
          <Link
            href={githubCommitUrl(c.slug, c.sha)}
            target="_blank"
            rel="noopener"
          >
            {c.repoName}@{shortSha(c.sha)}
          </Link>
          {c.match === 'base' && ' (base)'}
        </span>
      ))}{' '}
      · {ago(batch.created)}
    </Typography>
  </Box>
);

const BundleRow = ({
  bundle,
  repos,
  onOpenBuild,
  onForce,
}: {
  bundle: RunbotBundle;
  repos: ProjectDetails['repos'];
  onOpenBuild: (id: number) => void;
  onForce: (id: number) => void;
}) => {
  const slugOf = (repoId: number) =>
    repos.find(r => r.id === repoId)?.slug ?? '';
  const nameOf = (repoId: number) =>
    repos.find(r => r.id === repoId)?.name ?? `#${repoId}`;
  return (
    <TableRow>
      <TableCell style={{ verticalAlign: 'top', width: '28%' }}>
        <Typography variant="subtitle2">
          {bundle.name}
          {bundle.isBase && (
            <Chip size="small" label="base" style={{ marginLeft: 6 }} />
          )}
        </Typography>
        <Typography variant="caption" color="textSecondary">
          Odoo {bundle.version}
          {!bundle.isBase && ` · on ${bundle.baseName}`}
        </Typography>
        <Box>
          {bundle.branches
            .filter(b => b.alive)
            .map(b => (
              <Box key={b.id}>
                <Typography variant="caption">
                  <Link
                    href={
                      b.isPr
                        ? githubPrUrl(slugOf(b.repoId), b.prNumber!)
                        : githubTreeUrl(slugOf(b.repoId), b.name)
                    }
                    target="_blank"
                    rel="noopener"
                  >
                    {nameOf(b.repoId)}:{b.name}
                  </Link>
                  {b.isPr &&
                    ` ${b.prTitle ?? ''}${b.prDraft ? ' (draft)' : ''} → ${
                      b.prTarget
                    }`}
                </Typography>
              </Box>
            ))}
        </Box>
      </TableCell>
      <TableCell style={{ verticalAlign: 'top' }}>
        {bundle.lastBatch ? (
          <BatchLine batch={bundle.lastBatch} onOpenBuild={onOpenBuild} />
        ) : (
          <Typography variant="caption" color="textSecondary">
            No batch yet
          </Typography>
        )}
      </TableCell>
      <TableCell style={{ verticalAlign: 'top', width: 48 }}>
        <Tooltip title="Build now (new batch)">
          <IconButton size="small" onClick={() => onForce(bundle.id)}>
            <PlayArrowIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
};

const BuildsTable = ({
  builds,
  onOpenBuild,
}: {
  builds: RunbotBuildSummary[];
  onOpenBuild: (id: number) => void;
}) => (
  <Table size="small">
    <TableHead>
      <TableRow>
        <TableCell>Build</TableCell>
        <TableCell>Trigger</TableCell>
        <TableCell>State</TableCell>
        <TableCell>Builder</TableCell>
        <TableCell>Requested</TableCell>
        <TableCell>Duration</TableCell>
        <TableCell>First error</TableCell>
      </TableRow>
    </TableHead>
    <TableBody>
      {builds.map(b => (
        <TableRow
          key={b.id}
          hover
          style={{ cursor: 'pointer' }}
          onClick={() => onOpenBuild(b.id)}
        >
          <TableCell>#{b.id}</TableCell>
          <TableCell>{b.triggerName}</TableCell>
          <TableCell>
            <span
              style={{ color: RESULT_COLORS[stateLabel(b)], fontWeight: 600 }}
            >
              {stateLabel(b)}
            </span>
          </TableCell>
          <TableCell>{b.host ?? ''}</TableCell>
          <TableCell>{ago(b.requested)}</TableCell>
          <TableCell>{duration(b)}</TableCell>
          <TableCell
            style={{
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.errorSummary ?? ''}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

/**
 * The runbot: projects of repositories, their bundles (branches with the same
 * name across repos, and pull requests), the latest batch of each with one
 * build per trigger, builds, repositories and triggers, and the builders.
 */
export const RunbotView = () => {
  const api = useApi(runbotApiRef);
  const [projects, setProjects] = useState<RunbotProject[]>();
  const [projectId, setProjectId] = useState<number>();
  const [details, setDetails] = useState<ProjectDetails>();
  const [bundles, setBundles] = useState<RunbotBundle[]>([]);
  const [builds, setBuilds] = useState<RunbotBuildSummary[]>([]);
  const [hosts, setHosts] = useState<RunbotHost[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [openBuild, setOpenBuild] = useState<number | undefined>(() => {
    const id = Number(
      new URLSearchParams(window.location.search).get('runbotBuild'),
    );
    return Number.isInteger(id) && id > 0 ? id : undefined;
  });
  const [newProject, setNewProject] = useState(false);
  const [addRepo, setAddRepo] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setProjectId(prev => prev ?? list[0]?.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [d, b, bl, h] = await Promise.all([
        api.getProject(projectId),
        api.listBundles(projectId, search || undefined),
        api.listBuilds({ projectId, limit: 50 }),
        api.listHosts(),
      ]);
      setDetails(d);
      setBundles(b);
      setBuilds(bl);
      setHosts(h);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, projectId, search]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const force = async (bundleId: number) => {
    try {
      await api.forceBundle(bundleId);
      setNotice('A new batch will start within a few seconds.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setExecutor = async (triggerId: number, executor: BuildExecutor) => {
    try {
      await api.updateTrigger(triggerId, { executor });
      setNotice(
        `New builds of this trigger run in ${
          executor === 'docker' ? 'Docker' : 'Proxmox containers'
        }.`,
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const project = projects?.find(p => p.id === projectId);
  const stats = details?.stats;

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2} style={{ gap: 12 }}>
        <TextField
          select
          size="small"
          label="Project"
          value={projectId ?? ''}
          onChange={e => setProjectId(Number(e.target.value))}
          style={{ minWidth: 220 }}
          disabled={!projects?.length}
        >
          {(projects ?? []).map(p => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="outlined" onClick={() => setNewProject(true)}>
          New project
        </Button>
        <Button
          variant="contained"
          color="primary"
          disabled={!project}
          onClick={() => setAddRepo(true)}
        >
          Add repository
        </Button>
        <Box flex={1} />
        {stats && (
          <Typography variant="body2" color="textSecondary">
            {stats.pending} pending · {stats.testing} testing ·{' '}
            <span style={{ color: RESULT_COLORS.ok }}>{stats.ok} ok</span> ·{' '}
            <span style={{ color: RESULT_COLORS.warn }}>{stats.warn} warn</span>{' '}
            · <span style={{ color: RESULT_COLORS.ko }}>{stats.ko} ko</span>
          </Typography>
        )}
        <IconButton onClick={load}>
          <RefreshIcon />
        </IconButton>
      </Box>

      {error && (
        <Alert
          severity="error"
          onClose={() => setError(undefined)}
          style={{ marginBottom: 12 }}
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          severity="info"
          onClose={() => setNotice(undefined)}
          style={{ marginBottom: 12 }}
        >
          {notice}
        </Alert>
      )}
      {projects && projects.length === 0 && (
        <Alert severity="info">
          No runbot project yet. Create one (for example ISWE Odoo 19 with base
          branch 19.0), add odoo/odoo, then add the addons repositories to test.
        </Alert>
      )}

      {project && (
        <>
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            indicatorColor="primary"
            textColor="primary"
          >
            <Tab label={`Bundles (${bundles.length})`} />
            <Tab label="Builds" />
            <Tab
              label={`Repositories and triggers (${
                details?.repos.length ?? 0
              })`}
            />
            <Tab label={`Builders (${hosts.length})`} />
          </Tabs>

          {tab === 0 && (
            <Box mt={2}>
              <TextField
                size="small"
                placeholder="Search bundles (branch names)"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ marginBottom: 8, minWidth: 320 }}
              />
              <Table size="small">
                <TableBody>
                  {bundles.map(b => (
                    <BundleRow
                      key={b.id}
                      bundle={b}
                      repos={details?.repos ?? []}
                      onOpenBuild={setOpenBuild}
                      onForce={force}
                    />
                  ))}
                </TableBody>
              </Table>
              {bundles.length === 0 && (
                <Typography variant="body2" color="textSecondary">
                  No bundles yet. They appear after the first poll of a
                  repository (within a minute).
                </Typography>
              )}
            </Box>
          )}

          {tab === 1 && (
            <Box mt={2}>
              <BuildsTable builds={builds} onOpenBuild={setOpenBuild} />
            </Box>
          )}

          {tab === 2 && details && (
            <Grid container spacing={2} style={{ marginTop: 8 }}>
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6">Repositories</Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      Base branches {project.baseBranches.join(', ')}; other
                      branch names and default branches build on{' '}
                      {project.masterBase}.
                    </Typography>
                    {details.repos.map(r => (
                      <Box key={r.id} mb={1}>
                        <Typography variant="subtitle2">
                          <Link
                            href={`https://github.com/${r.slug}`}
                            target="_blank"
                            rel="noopener"
                          >
                            {r.slug}
                          </Link>
                          {r.isServer && (
                            <Chip
                              size="small"
                              label="odoo-bin"
                              style={{ marginLeft: 6 }}
                            />
                          )}
                          {!r.active && (
                            <Chip
                              size="small"
                              label="paused"
                              style={{ marginLeft: 6 }}
                            />
                          )}
                        </Typography>
                        <Typography
                          variant="caption"
                          color={r.pollError ? 'error' : 'textSecondary'}
                        >
                          {r.pollError
                            ? `Last poll failed: ${r.pollError}`
                            : `Default branch ${r.defaultBranch}${
                                r.addonsSubdir
                                  ? ` · modules in ${r.addonsSubdir}/`
                                  : ''
                              } · polled ${ago(r.lastPolled)}`}
                        </Typography>
                      </Box>
                    ))}
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6">Triggers</Typography>
                    <Typography variant="body2" color="textSecondary" paragraph>
                      A push to a tested repository builds it with its
                      dependencies; each reports a GitHub status.
                    </Typography>
                    {details.triggers.map(t => {
                      const names = (ids: number[]) =>
                        ids
                          .map(
                            id =>
                              details.repos.find(r => r.id === id)?.name ??
                              `#${id}`,
                          )
                          .join(', ');
                      const step = t.steps[0];
                      return (
                        <Box key={t.id} mb={1}>
                          <Typography variant="subtitle2">
                            {t.name}{' '}
                            <code style={{ fontSize: '0.75rem' }}>
                              {t.ciContext}
                            </code>
                            {!t.active && (
                              <Chip
                                size="small"
                                label="inactive"
                                style={{ marginLeft: 6 }}
                              />
                            )}
                          </Typography>
                          <TextField
                            select
                            size="small"
                            value={t.executor}
                            onChange={e =>
                              setExecutor(t.id, e.target.value as BuildExecutor)
                            }
                            style={{ marginRight: 8, minWidth: 150 }}
                            inputProps={{
                              'aria-label': `Executor of ${t.name}`,
                            }}
                          >
                            <MenuItem value="docker">Docker (VM)</MenuItem>
                            <MenuItem value="proxmox">Proxmox LXC</MenuItem>
                          </TextField>
                          <Typography variant="caption" color="textSecondary">
                            Tests {names(t.repoIds)}
                            {t.dependencyRepoIds.length
                              ? ` with ${names(t.dependencyRepoIds)}`
                              : ''}
                            {step &&
                              ` · modules ${step.modules.join(', ')}${
                                step.excludeModules.length
                                  ? ` except ${step.excludeModules.join(', ')}`
                                  : ''
                              } · ${
                                step.testTags || 'all tests'
                              } · timeout ${Math.round(step.timeout / 60)} min`}
                          </Typography>
                        </Box>
                      );
                    })}
                    {details.triggers.length === 0 && (
                      <Typography variant="body2">
                        No triggers: add a repository with "install and test".
                      </Typography>
                    )}
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          )}

          {tab === 3 && (
            <Table size="small" style={{ marginTop: 8 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Builder</TableCell>
                  <TableCell>Last seen</TableCell>
                  <TableCell>Workers</TableCell>
                  <TableCell>Running</TableCell>
                  <TableCell>Version</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {hosts.map(h => {
                  const stale =
                    Date.now() - Date.parse(h.lastSeen) > 5 * 60_000;
                  return (
                    <TableRow key={h.name}>
                      <TableCell>{h.name}</TableCell>
                      <TableCell
                        style={{ color: stale ? RESULT_COLORS.ko : undefined }}
                      >
                        {ago(h.lastSeen)}
                      </TableCell>
                      <TableCell>{h.workers}</TableCell>
                      <TableCell>
                        {h.running.map(id => (
                          <Link
                            key={id}
                            component="button"
                            onClick={() => setOpenBuild(id)}
                            style={{ marginRight: 6 }}
                          >
                            #{id}
                          </Link>
                        ))}
                      </TableCell>
                      <TableCell>{h.version}</TableCell>
                    </TableRow>
                  );
                })}
                {hosts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      No builder has reported yet: builds stay pending until one
                      runs (see the README).
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </>
      )}

      <BuildDialog
        buildId={openBuild}
        onClose={() => setOpenBuild(undefined)}
        onOpenBuild={setOpenBuild}
      />
      <NewProjectDialog
        open={newProject}
        onClose={() => setNewProject(false)}
        onCreated={p => {
          setProjects(prev => [...(prev ?? []), p]);
          setProjectId(p.id);
        }}
      />
      <AddRepositoryDialog
        open={addRepo}
        project={project}
        repos={details?.repos ?? []}
        onClose={() => setAddRepo(false)}
        onAdded={() => {
          setNotice(
            'Added. Its branches appear after the first poll, within a minute.',
          );
          load();
        }}
      />
    </Box>
  );
};
