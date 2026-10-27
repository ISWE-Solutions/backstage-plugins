import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  IconButton,
  MenuItem,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Tooltip,
  Typography,
  makeStyles,
} from '@material-ui/core';
import { Alert, Autocomplete } from '@material-ui/lab';
import DeleteIcon from '@material-ui/icons/Delete';
import AddIcon from '@material-ui/icons/Add';
import ArrowUpwardIcon from '@material-ui/icons/ArrowUpward';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  CreateOdooInstanceRequest,
  OdooAddonsRepo,
  OdooEnvironment,
  OdooOs,
  OdooServerConfig,
  PostgresCluster,
  ProxmoxNode,
} from '../types';
import {
  ENVIRONMENTS,
  ODOO_ENTERPRISE_URL,
  ODOO_VERSIONS,
  OS_INFO,
  clusterForEnvironment,
  computeAddonsPath,
  defaultSources,
  effectiveSources,
  hostnameFor,
  renderOdooConf,
  repoNameFromUrl,
  resolveDatabase,
  suggestServerConfig,
  validateCreateRequest,
} from '../odooConfig';

const useStyles = makeStyles(theme => ({
  section: { marginTop: theme.spacing(2), marginBottom: theme.spacing(1) },
  repoRow: {
    padding: theme.spacing(1),
    marginBottom: theme.spacing(1),
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
  },
  pre: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    background: theme.palette.background.default,
    padding: theme.spacing(1.5),
    borderRadius: theme.shape.borderRadius,
    maxHeight: 320,
    overflow: 'auto',
  },
}));

const STEPS = ['Basics', 'Sources', 'Database', 'Configuration', 'Review'];
const MB = 1024 * 1024;

/** An addons repository suggested from the catalog */
interface RepoSuggestion {
  title: string;
  url: string;
  entityRef: string;
}

export function initialRequest(
  versions: string[],
  clusters: PostgresCluster[],
): CreateOdooInstanceRequest {
  const version = versions[0] ?? '18.0';
  const environment: OdooEnvironment = 'staging';
  const resources = { cpu: 4, memory: 8192, storage: 100 };
  return {
    name: '',
    domain: '',
    environment,
    version,
    os: ODOO_VERSIONS[version]?.os[0] ?? 'ubuntu-24.04',
    edition: 'community',
    node: '',
    resources,
    sources: defaultSources(version, false),
    database: {
      placement: clusters.length ? 'cluster' : 'local',
      cluster: clusterForEnvironment(environment, clusters)?.name,
      name: '',
    },
    config: suggestServerConfig(
      resources,
      environment,
      clusters.length ? 'cluster' : 'local',
    ),
    addons: [],
    runbot_enabled: false,
  };
}

/** Suggested addons repositories: catalog Components tagged odoo, with a GitHub slug */
function useRepoSuggestions(open: boolean): RepoSuggestion[] {
  const catalogApi = useApi(catalogApiRef);
  const [suggestions, setSuggestions] = useState<RepoSuggestion[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!open) {
      return () => {
        cancelled = true;
      };
    }
    catalogApi
      .getEntities({
        filter: { kind: 'Component', 'metadata.tags': 'odoo' },
        fields: [
          'kind',
          'metadata.name',
          'metadata.namespace',
          'metadata.title',
          'metadata.annotations',
        ],
      })
      .then(({ items }) => {
        if (cancelled) return;
        setSuggestions(
          items
            .map(e => {
              const slug = e.metadata.annotations?.['github.com/project-slug'];
              return slug
                ? {
                    title: e.metadata.title ?? e.metadata.name,
                    url: `git@github.com:${slug}.git`,
                    entityRef: stringifyEntityRef(e),
                  }
                : undefined;
            })
            .filter((s): s is RepoSuggestion => Boolean(s))
            .sort((a, b) => a.title.localeCompare(b.title)),
        );
      })
      .catch(() => {
        // The catalog is only for suggestions; repositories can still be typed in
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalogApi]);
  return suggestions;
}

export interface CreateInstanceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (request: CreateOdooInstanceRequest) => Promise<void>;
  nodes: ProxmoxNode[];
  versions: string[];
  clusters: PostgresCluster[];
}

/**
 * Five-step form for a new instance: basics, code sources, database,
 * odoo.conf settings, and a review with the resulting addons_path, odoo.conf
 * and any problems.
 */
export const CreateInstanceDialog = ({
  open,
  onClose,
  onCreate,
  nodes,
  versions,
  clusters,
}: CreateInstanceDialogProps) => {
  const classes = useStyles();
  const [step, setStep] = useState(0);
  const [req, setReq] = useState<CreateOdooInstanceRequest>(() =>
    initialRequest(versions, clusters),
  );
  const [configTouched, setConfigTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const suggestions = useRepoSuggestions(open);

  useEffect(() => {
    if (open) {
      setReq(initialRequest(versions, clusters));
      setStep(0);
      setConfigTouched(false);
      setSubmitError(undefined);
    }
  }, [open, versions, clusters]);

  const validation = useMemo(
    () => validateCreateRequest(req, clusters),
    [req, clusters],
  );

  const update = (patch: Partial<CreateOdooInstanceRequest>) =>
    setReq(prev => {
      const next = { ...prev, ...patch };
      // Keep the suggested settings in step with size and environment until edited by hand
      if (
        !configTouched &&
        (patch.resources || patch.environment || patch.database)
      ) {
        next.config = suggestServerConfig(
          next.resources,
          next.environment,
          next.database.placement,
        );
      }
      return next;
    });
  const updateConfig = (patch: Partial<OdooServerConfig>) => {
    setConfigTouched(true);
    setReq(prev => ({ ...prev, config: { ...prev.config, ...patch } }));
  };

  const setVersion = (version: string) => {
    const allowed = ODOO_VERSIONS[version]?.os ?? [];
    const follow = (rev: string) => (/^\d+\.0$/.test(rev) ? version : rev);
    setReq(prev => ({
      ...prev,
      version,
      os: allowed.includes(prev.os) ? prev.os : allowed[0] ?? prev.os,
      sources: {
        community: {
          ...prev.sources.community,
          revision: follow(prev.sources.community.revision),
        },
        enterprise: prev.sources.enterprise && {
          ...prev.sources.enterprise,
          revision: follow(prev.sources.enterprise.revision),
        },
        addons: prev.sources.addons.map(a => ({
          ...a,
          revision: follow(a.revision),
        })),
      },
    }));
  };

  const setEnvironment = (environment: OdooEnvironment) =>
    update({
      environment,
      database: {
        ...req.database,
        cluster:
          req.database.placement === 'cluster'
            ? clusterForEnvironment(environment, clusters)?.name
            : undefined,
      },
    });

  const setEdition = (edition: CreateOdooInstanceRequest['edition']) =>
    setReq(prev => ({
      ...prev,
      edition,
      sources: {
        ...prev.sources,
        enterprise:
          edition === 'enterprise'
            ? prev.sources.enterprise ?? {
                url: ODOO_ENTERPRISE_URL,
                revision: prev.version,
                depth: 1,
              }
            : undefined,
      },
    }));

  const setAddons = (addons: OdooAddonsRepo[]) =>
    setReq(prev => ({ ...prev, sources: { ...prev.sources, addons } }));
  const updateRepo = (i: number, patch: Partial<OdooAddonsRepo>) =>
    setAddons(
      req.sources.addons.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    );

  const handleCreate = async () => {
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onCreate(req);
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const num = (v: string) => (v === '' ? 0 : Number(v));
  const db = resolveDatabase(req.database, clusters);

  const basics = (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <TextField
          fullWidth
          label="Instance name"
          value={req.name}
          onChange={e => update({ name: e.target.value })}
          helperText={
            req.name
              ? `Container hostname: ${hostnameFor(req.name)}`
              : 'e.g. Kugula ERP'
          }
        />
      </Grid>
      <Grid item xs={12} md={6}>
        <TextField
          fullWidth
          label="Domain"
          value={req.domain}
          onChange={e =>
            update({ domain: e.target.value.trim().toLowerCase() })
          }
          helperText="Served by nginx with TLS"
        />
      </Grid>
      <Grid item xs={12} md={4}>
        <TextField
          fullWidth
          select
          label="Environment"
          value={req.environment}
          onChange={e => setEnvironment(e.target.value as OdooEnvironment)}
          helperText="Sets the safe defaults and the database cluster"
        >
          {ENVIRONMENTS.map(env => (
            <MenuItem key={env} value={env}>
              {env[0].toUpperCase() + env.slice(1)}
            </MenuItem>
          ))}
        </TextField>
      </Grid>
      <Grid item xs={12} md={4}>
        <TextField
          fullWidth
          select
          label="Odoo version"
          value={req.version}
          onChange={e => setVersion(e.target.value)}
        >
          {versions.map(v => (
            <MenuItem key={v} value={v}>
              {v}
              {ODOO_VERSIONS[v] && !ODOO_VERSIONS[v].supported
                ? ' (no longer supported)'
                : ''}
            </MenuItem>
          ))}
        </TextField>
      </Grid>
      <Grid item xs={12} md={4}>
        <TextField
          fullWidth
          select
          label="Operating system"
          value={req.os}
          onChange={e => update({ os: e.target.value as OdooOs })}
          helperText={`Python ${OS_INFO[req.os].python}`}
        >
          {(ODOO_VERSIONS[req.version]?.os ?? []).map(os => (
            <MenuItem key={os} value={os}>
              {OS_INFO[os].label}
            </MenuItem>
          ))}
        </TextField>
      </Grid>
      <Grid item xs={12} md={4}>
        <TextField
          fullWidth
          select
          label="Edition"
          value={req.edition}
          onChange={e =>
            setEdition(e.target.value as CreateOdooInstanceRequest['edition'])
          }
        >
          <MenuItem value="community">Community</MenuItem>
          <MenuItem value="enterprise">Enterprise</MenuItem>
        </TextField>
      </Grid>
      <Grid item xs={12} md={4}>
        <TextField
          fullWidth
          select
          label="Proxmox node"
          value={req.node}
          onChange={e => update({ node: e.target.value })}
        >
          {nodes.map(n => (
            <MenuItem key={n.node} value={n.node}>
              {n.node}
            </MenuItem>
          ))}
        </TextField>
      </Grid>
      <Grid item xs={4} md={4} />
      <Grid item xs={4}>
        <TextField
          fullWidth
          type="number"
          label="CPU cores"
          value={req.resources.cpu}
          onChange={e =>
            update({
              resources: { ...req.resources, cpu: num(e.target.value) },
            })
          }
        />
      </Grid>
      <Grid item xs={4}>
        <TextField
          fullWidth
          type="number"
          label="Memory (MB)"
          value={req.resources.memory}
          onChange={e =>
            update({
              resources: { ...req.resources, memory: num(e.target.value) },
            })
          }
        />
      </Grid>
      <Grid item xs={4}>
        <TextField
          fullWidth
          type="number"
          label="Storage (GB)"
          value={req.resources.storage}
          onChange={e =>
            update({
              resources: { ...req.resources, storage: num(e.target.value) },
            })
          }
        />
      </Grid>
    </Grid>
  );

  const sourcesStep = (
    <>
      <Typography variant="subtitle2" className={classes.section}>
        Odoo
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <TextField
            fullWidth
            label="Repository"
            value={req.sources.community.url}
            onChange={e =>
              setReq(p => ({
                ...p,
                sources: {
                  ...p.sources,
                  community: { ...p.sources.community, url: e.target.value },
                },
              }))
            }
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            label="Branch, tag or commit"
            value={req.sources.community.revision}
            onChange={e =>
              setReq(p => ({
                ...p,
                sources: {
                  ...p.sources,
                  community: {
                    ...p.sources.community,
                    revision: e.target.value,
                  },
                },
              }))
            }
          />
        </Grid>
      </Grid>
      {req.edition === 'enterprise' && req.sources.enterprise && (
        <>
          <Typography variant="subtitle2" className={classes.section}>
            Odoo Enterprise
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={8}>
              <TextField
                fullWidth
                label="Repository (or your mirror)"
                value={req.sources.enterprise.url}
                onChange={e =>
                  setReq(p => ({
                    ...p,
                    sources: {
                      ...p.sources,
                      enterprise: {
                        ...p.sources.enterprise!,
                        url: e.target.value,
                      },
                    },
                  }))
                }
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                label="Branch, tag or commit"
                value={req.sources.enterprise.revision}
                onChange={e =>
                  setReq(p => ({
                    ...p,
                    sources: {
                      ...p.sources,
                      enterprise: {
                        ...p.sources.enterprise!,
                        revision: e.target.value,
                      },
                    },
                  }))
                }
              />
            </Grid>
          </Grid>
        </>
      )}
      <Typography variant="subtitle2" className={classes.section}>
        Addons repositories (searched in this order)
      </Typography>
      {req.sources.addons.map((repo, i) => (
        <Box key={i} className={classes.repoRow}>
          <Grid container spacing={1} alignItems="center">
            <Grid item xs={12} md={5}>
              <TextField
                fullWidth
                size="small"
                label="Repository URL"
                value={repo.url}
                onChange={e =>
                  updateRepo(i, {
                    url: e.target.value,
                    name: repo.name || repoNameFromUrl(e.target.value),
                  })
                }
              />
            </Grid>
            <Grid item xs={6} md={2}>
              <TextField
                fullWidth
                size="small"
                label="Folder"
                value={repo.name}
                onChange={e => updateRepo(i, { name: e.target.value })}
              />
            </Grid>
            <Grid item xs={6} md={2}>
              <TextField
                fullWidth
                size="small"
                label="Revision"
                value={repo.revision}
                onChange={e => updateRepo(i, { revision: e.target.value })}
              />
            </Grid>
            <Grid item xs={8} md={2}>
              <TextField
                fullWidth
                size="small"
                label="Modules in"
                placeholder="(root)"
                value={repo.subdir ?? ''}
                onChange={e =>
                  updateRepo(i, { subdir: e.target.value || undefined })
                }
              />
            </Grid>
            <Grid item xs={4} md={1}>
              <Tooltip title="Search earlier">
                <span>
                  <IconButton
                    size="small"
                    disabled={i === 0}
                    onClick={() => {
                      const a = [...req.sources.addons];
                      [a[i - 1], a[i]] = [a[i], a[i - 1]];
                      setAddons(a);
                    }}
                  >
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove">
                <IconButton
                  size="small"
                  onClick={() =>
                    setAddons(req.sources.addons.filter((_, j) => j !== i))
                  }
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Grid>
          </Grid>
          {repo.entityRef && (
            <Typography variant="caption" color="textSecondary">
              From the catalog: {repo.entityRef}
            </Typography>
          )}
        </Box>
      ))}
      <Grid container spacing={2} alignItems="center">
        <Grid item xs={12} md={8}>
          <Autocomplete
            options={suggestions.filter(
              s => !req.sources.addons.some(a => a.url === s.url),
            )}
            getOptionLabel={o =>
              `${o.title} (${o.url.replace(/^git@github.com:|\.git$/g, '')})`
            }
            onChange={(_, s) => {
              if (s) {
                setAddons([
                  ...req.sources.addons,
                  {
                    name: repoNameFromUrl(s.url),
                    url: s.url,
                    revision: req.version,
                    depth: 1,
                    entityRef: s.entityRef,
                  },
                ]);
              }
            }}
            value={null}
            noOptionsText="No Odoo components in the catalog"
            renderInput={params => (
              <TextField
                {...params}
                size="small"
                label="Add from the catalog (Components tagged odoo)"
              />
            )}
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <Button
            startIcon={<AddIcon />}
            onClick={() =>
              setAddons([
                ...req.sources.addons,
                { name: '', url: '', revision: req.version, depth: 1 },
              ])
            }
          >
            Add by URL
          </Button>
        </Grid>
      </Grid>
      <Typography variant="subtitle2" className={classes.section}>
        addons_path
      </Typography>
      <Box className={classes.pre}>
        {computeAddonsPath(effectiveSources(req)).join('\n')}
      </Box>
    </>
  );

  const databaseStep = (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <TextField
          fullWidth
          select
          label="PostgreSQL"
          value={req.database.placement}
          onChange={e => {
            const placement = e.target.value as 'local' | 'cluster';
            update({
              database: {
                ...req.database,
                placement,
                cluster:
                  placement === 'cluster'
                    ? clusterForEnvironment(req.environment, clusters)?.name
                    : undefined,
              },
            });
          }}
        >
          <MenuItem value="cluster" disabled={!clusters.length}>
            Shared cluster (recommended)
          </MenuItem>
          <MenuItem value="local">Local server in the container</MenuItem>
        </TextField>
      </Grid>
      {req.database.placement === 'cluster' && (
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            select
            label="Cluster"
            value={req.database.cluster ?? ''}
            onChange={e =>
              update({ database: { ...req.database, cluster: e.target.value } })
            }
            helperText="The cluster is the environment"
          >
            {clusters.map(c => (
              <MenuItem key={c.name} value={c.name}>
                {c.name}: {c.description ?? c.environment} (port {c.port})
              </MenuItem>
            ))}
          </TextField>
        </Grid>
      )}
      <Grid item xs={12} md={6}>
        <TextField
          fullWidth
          label="Database name"
          value={req.database.name}
          onChange={e =>
            update({ database: { ...req.database, name: e.target.value } })
          }
          helperText="<owner>_<app>[_<part>], e.g. kugula_odoo; no environment or version"
        />
      </Grid>
      <Grid item xs={12} md={6}>
        <TextField
          fullWidth
          label="Role"
          value={db.user}
          disabled
          helperText="Created with a generated password"
        />
      </Grid>
      <Grid item xs={12}>
        <Typography variant="body2" color="textSecondary">
          Connects to {db.host || '—'}:{db.port} with sslmode={db.sslmode}.
          {req.database.placement === 'cluster'
            ? ' The database and role are created on the cluster, with the unaccent extension.'
            : ' PostgreSQL is installed in the container; it has no replicas or point-in-time recovery.'}
        </Typography>
      </Grid>
    </Grid>
  );

  const c = req.config;
  const configStep = (
    <>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Typography variant="body2" color="textSecondary">
          {configTouched
            ? 'Edited by hand.'
            : `Suggested for ${req.resources.cpu} cores, ${req.resources.memory} MB and ${req.environment}.`}
        </Typography>
        <Button
          size="small"
          onClick={() => {
            setConfigTouched(false);
            setReq(p => ({
              ...p,
              config: suggestServerConfig(
                p.resources,
                p.environment,
                p.database.placement,
              ),
            }));
          }}
        >
          Suggest from size
        </Button>
      </Box>
      <Typography variant="subtitle2" className={classes.section}>
        Performance
      </Typography>
      <Grid container spacing={2}>
        {(
          [
            ['workers', 'Workers', 'number'],
            ['max_cron_threads', 'Cron threads', 'number'],
            ['db_maxconn', 'DB connections per process', 'number'],
            ['limit_time_cpu', 'CPU time limit (s)', 'number'],
            ['limit_time_real', 'Real time limit (s)', 'number'],
            [
              'limit_time_real_cron',
              'Cron time limit (s, -1 = same)',
              'number',
            ],
          ] as [keyof OdooServerConfig, string, string][]
        ).map(([key, label]) => (
          <Grid item xs={6} md={4} key={key}>
            <TextField
              fullWidth
              size="small"
              type="number"
              label={label}
              value={c[key] as number}
              onChange={e =>
                updateConfig({
                  [key]: num(e.target.value),
                } as Partial<OdooServerConfig>)
              }
            />
          </Grid>
        ))}
        <Grid item xs={6} md={4}>
          <TextField
            fullWidth
            size="small"
            type="number"
            label="Soft memory limit (MB)"
            value={Math.round(c.limit_memory_soft / MB)}
            onChange={e =>
              updateConfig({ limit_memory_soft: num(e.target.value) * MB })
            }
          />
        </Grid>
        <Grid item xs={6} md={4}>
          <TextField
            fullWidth
            size="small"
            type="number"
            label="Hard memory limit (MB)"
            value={Math.round(c.limit_memory_hard / MB)}
            onChange={e =>
              updateConfig({ limit_memory_hard: num(e.target.value) * MB })
            }
          />
        </Grid>
      </Grid>
      <Typography variant="subtitle2" className={classes.section}>
        Security
      </Typography>
      <Grid container spacing={2} alignItems="center">
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            size="small"
            label="dbfilter"
            value={c.dbfilter}
            onChange={e => updateConfig({ dbfilter: e.target.value })}
            helperText="^%d$: one database per host name"
          />
        </Grid>
        <Grid item xs={6} md={4}>
          <FormControlLabel
            control={
              <Checkbox
                checked={c.list_db}
                onChange={e => updateConfig({ list_db: e.target.checked })}
              />
            }
            label="Database manager (list_db)"
          />
        </Grid>
        <Grid item xs={6} md={4}>
          <FormControlLabel
            control={
              <Checkbox
                checked={c.proxy_mode}
                onChange={e => updateConfig({ proxy_mode: e.target.checked })}
              />
            }
            label="proxy_mode (behind nginx)"
          />
        </Grid>
        <Grid item xs={12} md={8}>
          <TextField
            fullWidth
            size="small"
            type="password"
            label="Master password"
            value={req.adminPassword ?? ''}
            onChange={e =>
              update({ adminPassword: e.target.value || undefined })
            }
            helperText="Leave empty to have a strong one generated and stored (recommended)"
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <FormControlLabel
            control={
              <Checkbox
                checked={c.without_demo}
                onChange={e => updateConfig({ without_demo: e.target.checked })}
              />
            }
            label="No demo data"
          />
        </Grid>
      </Grid>
      <Typography variant="subtitle2" className={classes.section}>
        Email
      </Typography>
      <Grid container spacing={2} alignItems="center">
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            size="small"
            label="SMTP server"
            value={c.smtp_server}
            onChange={e => updateConfig({ smtp_server: e.target.value })}
          />
        </Grid>
        <Grid item xs={4} md={2}>
          <TextField
            fullWidth
            size="small"
            type="number"
            label="Port"
            value={c.smtp_port}
            onChange={e => updateConfig({ smtp_port: num(e.target.value) })}
          />
        </Grid>
        <Grid item xs={8} md={2}>
          <FormControlLabel
            control={
              <Checkbox
                checked={c.smtp_ssl}
                onChange={e => updateConfig({ smtp_ssl: e.target.checked })}
              />
            }
            label="SSL"
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            size="small"
            label="SMTP user"
            value={c.smtp_user}
            onChange={e => updateConfig({ smtp_user: e.target.value })}
            helperText="Its password is stored separately"
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            size="small"
            label="Default sender (email_from)"
            value={c.email_from}
            onChange={e => updateConfig({ email_from: e.target.value })}
          />
        </Grid>
      </Grid>
      <Typography variant="subtitle2" className={classes.section}>
        Logging and other
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}>
          <TextField
            fullWidth
            size="small"
            select
            label="Log level"
            value={c.log_level}
            onChange={e =>
              updateConfig({
                log_level: e.target.value as OdooServerConfig['log_level'],
              })
            }
          >
            {['debug', 'info', 'warn', 'error', 'critical'].map(l => (
              <MenuItem key={l} value={l}>
                {l}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid item xs={6} md={3}>
          <TextField
            fullWidth
            size="small"
            label="Data directory"
            value={c.data_dir}
            onChange={e => updateConfig({ data_dir: e.target.value })}
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            size="small"
            label="Server-wide modules"
            value={c.server_wide_modules.join(',')}
            onChange={e =>
              updateConfig({
                server_wide_modules: e.target.value
                  .split(',')
                  .map(m => m.trim())
                  .filter(Boolean),
              })
            }
            helperText="e.g. base,web,queue_job"
          />
        </Grid>
        <Grid item xs={12}>
          <TextField
            fullWidth
            size="small"
            multiline
            minRows={2}
            label="Other odoo.conf options (key = value per line)"
            value={Object.entries(c.custom)
              .map(([k, v]) => `${k} = ${v}`)
              .join('\n')}
            onChange={e =>
              updateConfig({
                custom: Object.fromEntries(
                  e.target.value
                    .split('\n')
                    .map(l => l.split('='))
                    .filter(p => p.length >= 2 && p[0].trim())
                    .map(([k, ...v]) => [k.trim(), v.join('=').trim()]),
                ),
              })
            }
          />
        </Grid>
      </Grid>
    </>
  );

  const review = (
    <>
      {validation.errors.length > 0 && (
        <Alert severity="error" style={{ marginBottom: 12 }}>
          <strong>Fix before creating:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {validation.errors.map(e => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {validation.warnings.length > 0 && (
        <Alert severity="warning" style={{ marginBottom: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {validation.warnings.map(w => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      {validation.errors.length === 0 && validation.warnings.length === 0 && (
        <Alert severity="success" style={{ marginBottom: 12 }}>
          No problems found.
        </Alert>
      )}
      <Box mb={1}>
        <Chip size="small" label={req.environment} style={{ marginRight: 4 }} />
        <Chip
          size="small"
          label={`Odoo ${req.version} ${req.edition}`}
          style={{ marginRight: 4 }}
        />
        <Chip
          size="small"
          label={OS_INFO[req.os].label}
          style={{ marginRight: 4 }}
        />
        <Chip
          size="small"
          label={`${req.sources.addons.length} addons repositories`}
        />
      </Box>
      <Typography variant="subtitle2" className={classes.section}>
        odoo.conf (secrets are generated and stored, not shown)
      </Typography>
      <Box className={classes.pre}>{renderOdooConf(req, clusters)}</Box>
    </>
  );

  const content = [basics, sourcesStep, databaseStep, configStep, review][step];
  const last = step === STEPS.length - 1;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New Odoo instance</DialogTitle>
      <DialogContent>
        <Stepper activeStep={step} alternativeLabel>
          {STEPS.map((label, i) => (
            <Step
              key={label}
              onClick={() => setStep(i)}
              style={{ cursor: 'pointer' }}
            >
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
        {content}
        {submitError && (
          <Alert severity="error" style={{ marginTop: 12 }}>
            {submitError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {last ? (
          <Button
            color="primary"
            variant="contained"
            disabled={submitting || validation.errors.length > 0}
            onClick={handleCreate}
          >
            Create instance
          </Button>
        ) : (
          <Button
            color="primary"
            variant="contained"
            onClick={() => setStep(step + 1)}
          >
            Next
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
