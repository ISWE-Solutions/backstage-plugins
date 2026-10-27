import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import {
  AddRepoRequest,
  BuildExecutor,
  CreateProjectRequest,
  CreateTriggerRequest,
  LogLevel,
  RunbotBatch,
  RunbotBuild,
  RunbotBuildLog,
  RunbotBuildSummary,
  RunbotBundle,
  RunbotHost,
  RunbotProject,
  RunbotRepo,
  RunbotTrigger,
  TriggerStep,
} from '@iswesolutions/plugin-odoo-runbot-common';

export interface RunbotStats {
  pending: number;
  testing: number;
  ok: number;
  warn: number;
  ko: number;
  killed: number;
  skipped: number;
}

export interface ProjectDetails {
  project: RunbotProject;
  repos: RunbotRepo[];
  triggers: RunbotTrigger[];
  stats: RunbotStats;
}

/** Client for the odoo-runbot backend plugin */
export interface RunbotApi {
  listProjects(): Promise<RunbotProject[]>;
  getProject(id: number): Promise<ProjectDetails>;
  listBundles(projectId: number, search?: string): Promise<RunbotBundle[]>;
  getBundle(
    id: number,
  ): Promise<{ bundle: RunbotBundle; batches: RunbotBatch[] }>;
  listBuilds(opts?: {
    projectId?: number;
    state?: string;
    limit?: number;
  }): Promise<RunbotBuildSummary[]>;
  getBuild(id: number): Promise<RunbotBuild>;
  getLogs(
    id: number,
    opts?: { after?: number; levels?: LogLevel[] },
  ): Promise<RunbotBuildLog[]>;
  listHosts(): Promise<RunbotHost[]>;
  stats(): Promise<RunbotStats>;
  createProject(req: CreateProjectRequest): Promise<RunbotProject>;
  addRepo(
    req: AddRepoRequest,
  ): Promise<{ repo: RunbotRepo; trigger?: RunbotTrigger }>;
  setRepoActive(id: number, active: boolean): Promise<RunbotRepo>;
  createTrigger(req: CreateTriggerRequest): Promise<RunbotTrigger>;
  updateTrigger(
    id: number,
    patch: {
      steps?: TriggerStep[];
      active?: boolean;
      baseOnly?: boolean;
      executor?: BuildExecutor;
    },
  ): Promise<RunbotTrigger>;
  forceBundle(id: number): Promise<{ batchId: number }>;
  rebuild(id: number): Promise<{ buildId: number }>;
  kill(id: number): Promise<{ buildId: number }>;
}

export const runbotApiRef = createApiRef<RunbotApi>({
  id: 'plugin.odoo-runbot.service',
});

export class RunbotClient implements RunbotApi {
  constructor(
    private readonly deps: { discoveryApi: DiscoveryApi; fetchApi: FetchApi },
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const base = await this.deps.discoveryApi.getBaseUrl('odoo-runbot');
    const res = await this.deps.fetchApi.fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await ResponseError.fromResponse(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  listProjects = () => this.call<RunbotProject[]>('GET', '/projects');
  getProject = (id: number) =>
    this.call<ProjectDetails>('GET', `/projects/${id}`);
  listBundles = (projectId: number, search?: string) =>
    this.call<RunbotBundle[]>(
      'GET',
      `/projects/${projectId}/bundles${
        search ? `?search=${encodeURIComponent(search)}` : ''
      }`,
    );
  getBundle = (id: number) =>
    this.call<{ bundle: RunbotBundle; batches: RunbotBatch[] }>(
      'GET',
      `/bundles/${id}`,
    );
  listBuilds = (
    opts: { projectId?: number; state?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.projectId) q.set('projectId', String(opts.projectId));
    if (opts.state) q.set('state', opts.state);
    if (opts.limit) q.set('limit', String(opts.limit));
    return this.call<RunbotBuildSummary[]>('GET', `/builds?${q}`);
  };
  getBuild = (id: number) => this.call<RunbotBuild>('GET', `/builds/${id}`);
  getLogs = (
    id: number,
    opts: { after?: number; levels?: LogLevel[] } = {},
  ) => {
    const q = new URLSearchParams({
      after: String(opts.after ?? 0),
      limit: '2000',
    });
    if (opts.levels?.length) q.set('levels', opts.levels.join(','));
    return this.call<RunbotBuildLog[]>('GET', `/builds/${id}/logs?${q}`);
  };
  listHosts = () => this.call<RunbotHost[]>('GET', '/hosts');
  stats = () => this.call<RunbotStats>('GET', '/stats');
  createProject = (req: CreateProjectRequest) =>
    this.call<RunbotProject>('POST', '/projects', req);
  addRepo = (req: AddRepoRequest) =>
    this.call<{ repo: RunbotRepo; trigger?: RunbotTrigger }>(
      'POST',
      '/repos',
      req,
    );
  setRepoActive = (id: number, active: boolean) =>
    this.call<RunbotRepo>('PATCH', `/repos/${id}`, { active });
  createTrigger = (req: CreateTriggerRequest) =>
    this.call<RunbotTrigger>('POST', '/triggers', req);
  updateTrigger = (
    id: number,
    patch: {
      steps?: TriggerStep[];
      active?: boolean;
      baseOnly?: boolean;
      executor?: BuildExecutor;
    },
  ) => this.call<RunbotTrigger>('PATCH', `/triggers/${id}`, patch);
  forceBundle = (id: number) =>
    this.call<{ batchId: number }>('POST', `/bundles/${id}/force`);
  rebuild = (id: number) =>
    this.call<{ buildId: number }>('POST', `/builds/${id}/rebuild`);
  kill = (id: number) =>
    this.call<{ buildId: number }>('POST', `/builds/${id}/kill`);
}
