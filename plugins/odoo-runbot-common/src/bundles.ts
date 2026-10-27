import {
  BatchCommit,
  BuildCommit,
  BuildParams,
  RunbotProject,
  RunbotRepo,
  RunbotTrigger,
} from './types';

/**
 * The base bundle of a branch name, as runbot decides it: a base branch is its
 * own base; otherwise the longest base branch the name starts with
 * ("19.0-fix-taxes" → "19.0"); otherwise the project's master base (so the
 * "main" branch of an addons repo builds against odoo 19.0).
 */
export function baseFor(
  project: Pick<RunbotProject, 'baseBranches' | 'masterBase'>,
  bundleName: string,
): string {
  if (project.baseBranches.includes(bundleName)) return bundleName;
  const prefixed = project.baseBranches
    .filter(
      b => bundleName.startsWith(`${b}-`) || bundleName.startsWith(`${b}.`),
    )
    .sort((a, b) => b.length - a.length)[0];
  return prefixed ?? project.masterBase;
}

/** Odoo version of a base branch name: "19.0", "saas-18.4" → "18.4", else the name */
export function versionOf(baseName: string): string {
  const m = baseName.match(/(\d+\.\d+)$/);
  return m ? m[1] : baseName;
}

/**
 * The bundle name for a pull request: its head branch, without the fork owner,
 * so a PR from a fork lands in the same bundle as same-named branches.
 */
export function bundleNameForPr(headRef: string): string {
  return headRef.includes(':')
    ? headRef.split(':').slice(1).join(':')
    : headRef;
}

/**
 * The commits of a batch: for each repo the project's triggers need, the
 * bundle's own branch if it has one, otherwise the base bundle's branch.
 * Repos with neither are left out (the trigger will be skipped).
 */
export function batchCommits(
  repos: RunbotRepo[],
  bundleHeads: Map<number, string>,
  baseHeads: Map<number, string>,
): BatchCommit[] {
  const out: BatchCommit[] = [];
  for (const repo of repos) {
    const head = bundleHeads.get(repo.id);
    const base = baseHeads.get(repo.id);
    if (head)
      out.push({
        repoId: repo.id,
        repoName: repo.name,
        slug: repo.slug,
        sha: head,
        match: 'head',
      });
    else if (base)
      out.push({
        repoId: repo.id,
        repoName: repo.name,
        slug: repo.slug,
        sha: base,
        match: 'base',
      });
  }
  return out;
}

const sortCommits = (c: BuildCommit[]) =>
  [...c].sort((a, b) => a.repoId - b.repoId);

export type TriggerDecision =
  | { run: true; params: BuildParams }
  | { run: false; reason: string };

/**
 * Whether a trigger builds in a batch, and with what. Runbot's rules:
 * - every repo the trigger needs must have a commit
 * - on a dev bundle, at least one trigger repo must have its own branch
 *   (otherwise it would only rebuild the base)
 * - base-only triggers run on base bundles only
 */
export function decideTrigger(
  trigger: RunbotTrigger,
  repos: RunbotRepo[],
  commits: BatchCommit[],
  bundle: { isBase: boolean; version: string },
): TriggerDecision {
  if (!trigger.active) return { run: false, reason: 'Trigger is inactive' };
  if (trigger.baseOnly && !bundle.isBase)
    return { run: false, reason: 'Base bundles only' };
  const byId = new Map(commits.map(c => [c.repoId, c]));
  const needed = [...trigger.repoIds, ...trigger.dependencyRepoIds];
  const missing = needed.filter(id => !byId.has(id));
  if (missing.length) {
    const names = missing.map(
      id => repos.find(r => r.id === id)?.name ?? `#${id}`,
    );
    return { run: false, reason: `No commit for ${names.join(', ')}` };
  }
  if (
    !bundle.isBase &&
    !trigger.repoIds.some(id => byId.get(id)!.match === 'head')
  ) {
    return {
      run: false,
      reason: 'No branch of the tested repositories in this bundle',
    };
  }
  const buildCommits: BuildCommit[] = needed.map(id => {
    const repo = repos.find(r => r.id === id)!;
    const c = byId.get(id)!;
    return {
      repoId: id,
      repoName: repo.name,
      slug: repo.slug,
      sha: c.sha,
      isServer: repo.isServer,
      addonsSubdir: repo.addonsSubdir,
      tested: trigger.repoIds.includes(id),
    };
  });
  if (!buildCommits.some(c => c.isServer)) {
    return {
      run: false,
      reason: 'No repository provides odoo-bin (add odoo/odoo as a dependency)',
    };
  }
  return {
    run: true,
    params: {
      version: bundle.version,
      commits: sortCommits(buildCommits),
      steps: trigger.steps,
    },
  };
}

/** Canonical JSON (sorted keys), so equal params give the same hash */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter(k => (value as any)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
