import { createHash } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  baseFor,
  batchCommits,
  bundleNameForPr,
  canonicalJson,
  decideTrigger,
  RunbotRepo,
  versionOf,
} from '@iswesolutions/plugin-odoo-runbot-common';
import { GithubClient } from './github';
import { RunbotStore } from './store';
import { StatusReporter } from './statuses';

export const paramsHash = (params: unknown) =>
  createHash('sha256').update(canonicalJson(params)).digest('hex');

/**
 * The leader: reads branches and pull requests from GitHub, keeps bundles up
 * to date, opens batches when heads move, and turns ready batches into builds.
 * Runs inside the Backstage backend on a schedule (one instance at a time).
 */
export class Leader {
  constructor(
    private readonly store: RunbotStore,
    private readonly github: GithubClient,
    private readonly statuses: StatusReporter,
    private readonly logger: LoggerService,
  ) {}

  /** Poll every active repo; returns the number of new batches */
  async pollAll(): Promise<number> {
    let batches = 0;
    for (const repo of await this.store.listRepos(undefined, true)) {
      try {
        batches += await this.pollRepo(repo);
        await this.store.setRepoPolled(repo.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`runbot: polling ${repo.slug} failed: ${msg}`);
        await this.store.setRepoPolled(repo.id, msg);
      }
    }
    return batches;
  }

  async pollRepo(repo: RunbotRepo): Promise<number> {
    const project = await this.store.getProject(repo.projectId);
    if (!project) return 0;
    const triggers = (await this.store.listTriggers(project.id)).filter(
      t => t.active,
    );
    // As in runbot, only a trigger's tested repos create batches; a new commit in
    // a dependency (odoo/odoo moves many times a day) is picked up by the next one
    const triggering = triggers.some(t => t.repoIds.includes(repo.id));
    const bases = new Set([...project.baseBranches, project.masterBase]);

    // The server repo (odoo/odoo) only matters on its base branches, and its
    // thousands of pull requests are never read
    const branches = (await this.github.listBranches(repo.slug)).filter(
      b => !repo.isServer || bases.has(b.name),
    );
    const pulls = repo.isServer
      ? []
      : await this.github.listOpenPulls(repo.slug);

    const bundleFor = async (branchName: string, canBeBase: boolean) => {
      // A default branch that isn't a version name ("main") is the repo's part
      // of the master base bundle
      const name =
        canBeBase &&
        branchName === repo.defaultBranch &&
        !project.baseBranches.includes(branchName)
          ? project.masterBase
          : branchName;
      const isBase = canBeBase && project.baseBranches.includes(name);
      const baseName = isBase ? name : baseFor(project, name);
      return this.store.getOrCreateBundle({
        projectId: project.id,
        name,
        isBase,
        baseName,
        version: versionOf(baseName),
      });
    };

    const changedBundles = new Set<number>();
    const alive: string[] = [];
    for (const b of branches) {
      const bundleId = await bundleFor(b.name, true);
      alive.push(b.name);
      if (
        await this.store.upsertBranch({
          repoId: repo.id,
          name: b.name,
          headSha: b.sha,
          bundleId,
        })
      ) {
        changedBundles.add(bundleId);
      }
    }
    for (const p of pulls) {
      const name = `#${p.number}`;
      const bundleId = await bundleFor(bundleNameForPr(p.headRef), false);
      alive.push(name);
      const changed = await this.store.upsertBranch({
        repoId: repo.id,
        name,
        headSha: p.headSha,
        bundleId,
        pr: {
          number: p.number,
          target: p.target,
          title: p.title,
          author: p.author,
          draft: p.draft,
          headSlug: p.headSlug,
        },
      });
      if (changed) changedBundles.add(bundleId);
    }
    await this.store.markDeadBranches(repo.id, alive);

    if (!triggering) return 0;
    for (const bundleId of changedBundles)
      await this.store.requestBatch(bundleId);
    return changedBundles.size;
  }

  /** Turn batches that have waited long enough into builds */
  async prepareBatches(): Promise<number> {
    const due = await this.store.preparingBatchesDue();
    for (const { id, bundleId } of due) {
      try {
        await this.prepareBatch(id, bundleId);
      } catch (e) {
        this.logger.error(
          `runbot: preparing batch ${id} failed: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    return due.length;
  }

  async prepareBatch(batchId: number, bundleId: number) {
    const bundle = await this.store.getBundle(bundleId);
    if (!bundle) return;
    const repos = await this.store.listRepos(bundle.projectId, true);
    const triggers = await this.store.listTriggers(bundle.projectId);
    const heads = await this.store.bundleHeads(bundleId);
    const base = bundle.isBase
      ? undefined
      : await this.store.findBundle(bundle.projectId, bundle.baseName);
    const baseHeads = base
      ? await this.store.bundleHeads(base.id)
      : new Map<number, string>();
    const commits = batchCommits(repos, heads, baseHeads);

    const slots: {
      triggerId: number;
      buildId?: number;
      skipReason?: string;
    }[] = [];
    const newBuilds: number[] = [];
    for (const trigger of triggers) {
      const decision = decideTrigger(trigger, repos, commits, bundle);
      if (!decision.run) {
        slots.push({ triggerId: trigger.id, skipReason: decision.reason });
        continue;
      }
      const hash = paramsHash(decision.params);
      const existing = await this.store.findReusableBuild(hash);
      if (existing) {
        slots.push({ triggerId: trigger.id, buildId: existing.id });
      } else {
        const id = await this.store.createBuild({
          projectId: bundle.projectId,
          triggerId: trigger.id,
          paramsHash: hash,
          params: decision.params,
        });
        newBuilds.push(id);
        slots.push({ triggerId: trigger.id, buildId: id });
      }
    }
    await this.store.setBatchReady(batchId, commits, slots);
    if (!bundle.sticky) {
      const skipped = await this.store.skipSuperseded(bundleId, batchId);
      for (const id of skipped) await this.statuses.report(id);
    }
    for (const id of newBuilds) await this.statuses.report(id);
  }

  /** Builds left "testing" by a builder that disappeared go back to the queue */
  async requeueOrphans(staleMinutes = 5) {
    const ids = await this.store.requeueOrphans(
      new Date(Date.now() - staleMinutes * 60_000).toISOString(),
    );
    if (ids.length)
      this.logger.warn(
        `runbot: requeued builds of silent builders: ${ids.join(', ')}`,
      );
    return ids;
  }
}
