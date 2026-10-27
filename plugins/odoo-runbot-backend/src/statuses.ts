import { LoggerService } from '@backstage/backend-plugin-api';
import { GithubClient, StatusState } from './github';
import { RunbotStore } from './store';

/**
 * GitHub commit statuses for builds, on the commits of the tested repos
 * (runbot's "ci/runbot" checks). Best effort: a failure is logged, not thrown.
 */
export class StatusReporter {
  constructor(
    private readonly store: RunbotStore,
    private readonly github: GithubClient,
    private readonly logger: LoggerService,
    private readonly opts: {
      enabled: boolean;
      buildUrl: (id: number) => string;
    },
  ) {}

  async report(buildId: number) {
    if (!this.opts.enabled) return;
    const build = await this.store.getBuild(buildId);
    if (!build) return;
    const trigger = (await this.store.listTriggers(build.projectId)).find(
      t => t.id === build.triggerId,
    );
    if (!trigger) return;
    let state: StatusState;
    let description: string;
    if (build.localState === 'pending') {
      state = 'pending';
      description = 'Waiting for a builder';
    } else if (build.localState !== 'done') {
      state = 'pending';
      description = `Testing on ${build.host ?? 'a builder'}`;
    } else if (build.result === 'ok' || build.result === 'warn') {
      state = 'success';
      description =
        build.result === 'warn' ? 'Passed, with warnings' : 'Passed';
    } else if (build.result === 'ko') {
      state = 'failure';
      description = build.errorSummary ?? 'Failed';
    } else {
      state = 'error';
      description = build.result === 'killed' ? 'Killed' : 'Skipped';
    }
    for (const c of build.params.commits.filter(x => x.tested)) {
      try {
        await this.github.setStatus(c.slug, c.sha, {
          state,
          context: trigger.ciContext,
          description,
          targetUrl: this.opts.buildUrl(buildId),
        });
      } catch (e) {
        this.logger.warn(
          `runbot: status for ${c.slug}@${c.sha.slice(0, 8)}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }
}
