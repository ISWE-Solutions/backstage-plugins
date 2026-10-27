/**
 * The runbot data model, after odoo/runbot:
 *
 * - Project: repositories that are built together, with base bundles (the
 *   version branches, e.g. 19.0) and a master base for other branch names.
 * - Repo: a GitHub repository (owner/name). One per project provides odoo-bin.
 * - Branch: a branch or open pull request of a repo, at a head commit.
 * - Bundle: all branches with the same name in a project's repos (a feature
 *   across odoo and an addons repo, say). Base bundles are the version branches.
 * - Trigger: what to build when a commit arrives on its repos: which repos'
 *   modules to install and test, with which dependency repos, and how.
 * - Batch: the commits of one bundle at one moment; builds are made from it.
 * - Build: one trigger run on one set of commits. Identical requests reuse it.
 */

export type BuildLocalState = 'pending' | 'testing' | 'running' | 'done';
export type BuildResult = 'ok' | 'warn' | 'ko' | 'killed' | 'skipped';
export type BatchState = 'preparing' | 'ready' | 'done' | 'skipped';
/** head: the bundle's own branch; base: the base bundle's branch filled it in */
export type CommitMatch = 'head' | 'base';
/**
 * Where a build runs:
 * - docker: a container on a builder VM (the default; build code stays inside the VM)
 * - proxmox: a short-lived LXC container cloned from a per-version template
 *   on a Proxmox node (its own IP and PostgreSQL; build code runs on the node's kernel)
 */
export type BuildExecutor = 'docker' | 'proxmox';
export const BUILD_EXECUTORS: BuildExecutor[] = ['docker', 'proxmox'];

export type LogLevel =
  | 'DEBUG'
  | 'INFO'
  | 'WARNING'
  | 'ERROR'
  | 'CRITICAL'
  | 'RUNBOT';

export interface RunbotProject {
  id: number;
  name: string;
  /** Branch names that are base bundles, e.g. ["19.0", "18.0"] */
  baseBranches: string[];
  /** Base for branch names that match no base branch (ISWE's "main" → 19.0) */
  masterBase: string;
  /** Seconds a batch waits for commits from the project's other repos */
  batchDelay: number;
  created: string;
}

export interface RunbotRepo {
  id: number;
  projectId: number;
  /** Short name shown in the UI, e.g. iswe_meal_addons */
  name: string;
  /** GitHub owner/name */
  slug: string;
  /** Provides odoo-bin (the odoo/odoo repo) */
  isServer: boolean;
  /** Folder inside the repo that holds the modules ("" for the root) */
  addonsSubdir: string;
  /**
   * The repo's default branch on GitHub. When it isn't a version name (ISWE's
   * "main"), it joins the project's master base bundle, so it is the base of
   * the repo's feature branches and fills in for it in other bundles.
   */
  defaultBranch: string;
  /** Catalog entity the repo was added from, if any */
  entityRef?: string;
  active: boolean;
  lastPolled?: string;
  pollError?: string;
  created: string;
}

/** One step of a trigger's configuration */
export interface InstallTestStep {
  type: 'install_test';
  /** Modules to install; globs over the trigger repos' modules, default ["*"] */
  modules: string[];
  /** Modules never installed, globs */
  excludeModules: string[];
  /** --test-tags; empty runs every test of the installed modules */
  testTags: string;
  /** Install demo data (Odoo's tests mostly need it) */
  demo: boolean;
  /** Seconds before the build is killed */
  timeout: number;
}

export type TriggerStep = InstallTestStep;

export interface RunbotTrigger {
  id: number;
  projectId: number;
  name: string;
  /** A new commit in one of these repos creates builds; their modules are tested */
  repoIds: number[];
  /** Also checked out (e.g. odoo), but their modules are not tested */
  dependencyRepoIds: number[];
  steps: TriggerStep[];
  /** GitHub status context, e.g. ci/runbot-meal */
  ciContext: string;
  /** Where its builds run */
  executor: BuildExecutor;
  /** Only base bundles (nightly-style triggers) */
  baseOnly: boolean;
  active: boolean;
  sequence: number;
}

export interface RunbotBranch {
  id: number;
  repoId: number;
  name: string;
  headSha: string;
  bundleId: number;
  isPr: boolean;
  prNumber?: number;
  prTarget?: string;
  prTitle?: string;
  prAuthor?: string;
  prDraft?: boolean;
  /** Head repository of the PR, owner/name (a fork, or the repo itself) */
  prHeadSlug?: string;
  alive: boolean;
  updated: string;
}

export interface RunbotCommit {
  repoId: number;
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface BatchCommit {
  repoId: number;
  repoName: string;
  slug: string;
  sha: string;
  match: CommitMatch;
  subject?: string;
  author?: string;
}

/** A trigger's build in a batch */
export interface BatchSlot {
  triggerId: number;
  triggerName: string;
  buildId?: number;
  /** Set when the trigger doesn't apply to this batch */
  skipReason?: string;
  build?: RunbotBuildSummary;
}

export interface RunbotBatch {
  id: number;
  bundleId: number;
  state: BatchState;
  created: string;
  readyAt?: string;
  commits: BatchCommit[];
  slots: BatchSlot[];
}

export interface RunbotBundle {
  id: number;
  projectId: number;
  name: string;
  isBase: boolean;
  baseName: string;
  /** Odoo version, from the base bundle */
  version: string;
  sticky: boolean;
  branches: RunbotBranch[];
  lastBatch?: RunbotBatch;
  updated: string;
}

/** The commits a build checks out, with where each goes */
export interface BuildCommit {
  repoId: number;
  repoName: string;
  slug: string;
  sha: string;
  isServer: boolean;
  addonsSubdir: string;
  /** Trigger repo (modules tested) or dependency */
  tested: boolean;
}

/** Everything that decides a build's outcome; equal params reuse a build */
export interface BuildParams {
  version: string;
  executor: BuildExecutor;
  commits: BuildCommit[];
  steps: TriggerStep[];
}

export interface RunbotBuildSummary {
  id: number;
  triggerId: number;
  triggerName: string;
  localState: BuildLocalState;
  result?: BuildResult;
  requested: string;
  started?: string;
  finished?: string;
  host?: string;
  errorSummary?: string;
}

export interface RunbotBuild extends RunbotBuildSummary {
  projectId: number;
  params: BuildParams;
  paramsHash: string;
  killRequested: boolean;
  /** Batches that use this build */
  batchIds: number[];
}

export interface RunbotBuildLog {
  id: number;
  buildId: number;
  level: LogLevel;
  logger: string;
  message: string;
  created: string;
}

export interface RunbotHost {
  name: string;
  lastSeen: string;
  workers: number;
  running: number[];
  version: string;
}

/** What a builder receives when it claims a build */
export interface BuildAssignment {
  buildId: number;
  params: BuildParams;
  dbName: string;
}

/** Requests from the page */
export interface CreateProjectRequest {
  name: string;
  baseBranches: string[];
  masterBase: string;
  batchDelay?: number;
}

export interface AddRepoRequest {
  projectId: number;
  slug: string;
  name?: string;
  isServer?: boolean;
  addonsSubdir?: string;
  entityRef?: string;
  /** Create a trigger that installs and tests this repo's modules, with the project's server repo */
  createTrigger?: boolean;
  /** Executor of that trigger; default docker */
  executor?: BuildExecutor;
}

export interface CreateTriggerRequest {
  projectId: number;
  name: string;
  repoIds: number[];
  dependencyRepoIds: number[];
  steps?: TriggerStep[];
  ciContext?: string;
  baseOnly?: boolean;
  executor?: BuildExecutor;
}
