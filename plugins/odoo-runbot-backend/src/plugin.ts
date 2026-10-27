import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { runbotPermissions } from '@iswesolutions/plugin-odoo-runbot-common';
import { createGithubClient } from './github';
import { Leader } from './leader';
import { createRouter } from './router';
import { StatusReporter } from './statuses';
import { createRunbotStore } from './store';

/**
 * ISWE Runbot: continuous integration for Odoo repositories, after odoo/runbot.
 * The leader runs here (GitHub polling, bundles, batches, builds); builders on
 * other hosts claim builds through the builder endpoints. See the README.
 */
export const odooRunbotBackend = createBackendPlugin({
  pluginId: 'odoo-runbot',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        scheduler: coreServices.scheduler,
        database: coreServices.database,
      },
      async init({
        logger,
        config,
        httpRouter,
        httpAuth,
        permissions,
        permissionsRegistry,
        scheduler,
        database,
      }) {
        permissionsRegistry.addPermissions(runbotPermissions);
        const cfg = config.getOptionalConfig('odooRunbot');
        // A dedicated token, else the GitHub integration's
        const token =
          cfg?.getOptionalString('github.token') ??
          config
            .getOptionalConfigArray('integrations.github')
            ?.find(
              g =>
                (g.getOptionalString('host') ?? 'github.com') === 'github.com',
            )
            ?.getOptionalString('token');
        if (!token)
          logger.warn(
            'odoo-runbot: no GitHub token; only public repositories can be polled',
          );

        const github = createGithubClient({ token });
        const store = await createRunbotStore(database);
        const appBaseUrl = config.getString('app.baseUrl').replace(/\/$/, '');
        const pagePath = cfg?.getOptionalString('pagePath') ?? '/odoo';
        const statuses = new StatusReporter(store, github, logger, {
          enabled: cfg?.getOptionalBoolean('github.statuses') ?? true,
          buildUrl: id => `${appBaseUrl}${pagePath}?runbotBuild=${id}`,
        });
        const leader = new Leader(store, github, statuses, logger);

        const pollSeconds = cfg?.getOptionalNumber('pollSeconds') ?? 60;
        await scheduler.scheduleTask({
          id: 'odoo-runbot-poll',
          frequency: { seconds: pollSeconds },
          timeout: { minutes: 5 },
          initialDelay: { seconds: 20 },
          fn: async () => {
            await leader.pollAll();
          },
        });
        await scheduler.scheduleTask({
          id: 'odoo-runbot-batches',
          frequency: { seconds: 15 },
          timeout: { minutes: 2 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            await leader.prepareBatches();
            await leader.requeueOrphans();
          },
        });

        httpRouter.use(
          await createRouter({
            store,
            leader,
            statuses,
            github,
            httpAuth,
            permissions,
            logger,
            builderSubject:
              cfg?.getOptionalString('builder.subject') ??
              'odoo-runbot-builder',
          }),
        );
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
      },
    });
  },
});
