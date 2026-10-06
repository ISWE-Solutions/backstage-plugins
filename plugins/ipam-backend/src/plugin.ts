import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { notificationService } from '@backstage/plugin-notifications-node';
import { ipamPermissions } from '@iswesolutions/plugin-ipam-common';
import { createPhpIpamClient } from './phpipamClient';
import { createRouter } from './router';
import { AllocationService } from './allocation';
import { runNotifier } from './notifier';
import { createDatabaseIssueStore } from './issueStore';
import { createUsageHistory } from './usageHistory';
import { createSyncStatusStore } from './syncStatus';
import { checkDns, createResolver } from './dnsCheck';

/**
 * Backend for the IPAM plugin: a permission-checked gateway to phpIPAM,
 * static-address allocation for new containers (ipam.allocation),
 * and Backstage notifications for new issues (ipam.notifications).
 * See docs/infrastructure/ipam.
 */
export const ipamBackend = createBackendPlugin({
  pluginId: 'ipam',
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
        notifications: notificationService,
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
        notifications,
      }) {
        permissionsRegistry.addPermissions(ipamPermissions);

        const url = config.getOptionalString('ipam.phpipam.url');
        const appCode = config.getOptionalString('ipam.phpipam.appCode');
        if (!url || !appCode) {
          logger.warn(
            'ipam: ipam.phpipam.url/appCode not configured; the IPAM page will show an error',
          );
        }
        const phpipam = createPhpIpamClient({
          url: url ?? 'http://phpipam.invalid/',
          appCode: appCode ?? '',
          verifyTls:
            config.getOptionalBoolean('ipam.phpipam.verifyTls') ?? true,
        });

        const alloc = config.getOptionalConfig('ipam.allocation');
        const allocations = alloc
          ? new AllocationService(
              phpipam,
              {
                subnet: alloc.getString('subnet'),
                prefix: alloc.getNumber('prefix'),
                from: alloc.getString('from'),
                to: alloc.getString('to'),
                gateway: alloc.getString('gateway'),
                nameserver: alloc.getOptionalString('nameserver'),
              },
              logger,
            )
          : undefined;

        const usageHistory =
          url && appCode
            ? await createUsageHistory(database, phpipam, logger)
            : undefined;
        const syncStatus = await createSyncStatusStore(database);
        const resolver = createResolver(
          config.getOptionalStringArray('ipam.dns.servers'),
        );
        const dnsCheck = async () => {
          const r = await phpipam.request('GET', 'addresses/');
          return checkDns(((r.body as any)?.data ?? []) as any[], resolver);
        };

        if (usageHistory) {
          // one snapshot a day (and one at startup so the chart is never empty)
          await scheduler.scheduleTask({
            id: 'ipam-usage-snapshot',
            frequency: { hours: 24 },
            timeout: { minutes: 5 },
            initialDelay: { minutes: 1 },
            fn: async () => {
              await usageHistory.snapshot();
            },
          });
        }

        httpRouter.use(
          await createRouter({
            logger,
            httpAuth,
            permissions,
            phpipam,
            allocations,
            usageHistory,
            syncStatus,
            syncSubject:
              config.getOptionalString('ipam.sync.subject') ?? 'ipam-sync',
            dnsCheck,
            publicConfig: {
              dhcpRanges: (
                config.getOptionalConfigArray('ipam.dhcpRanges') ?? []
              ).map(r => ({
                from: r.getString('from'),
                to: r.getString('to'),
              })),
              proxmoxUiUrls:
                config.getOptional<Record<string, string>>(
                  'ipam.proxmoxUiUrls',
                ) ?? {},
            },
          }),
        );

        if (
          url &&
          appCode &&
          config.getOptionalBoolean('ipam.notifications.enabled')
        ) {
          const recipients = config.getOptionalStringArray(
            'ipam.notifications.recipients',
          ) ?? ['group:default/phpipam-admins'];
          const configuredThresholds = config.getOptional<number[]>(
            'ipam.notifications.thresholds',
          );
          const store = await createDatabaseIssueStore(database);
          await scheduler.scheduleTask({
            id: 'ipam-notify-new-issues',
            frequency: { minutes: 15 },
            timeout: { minutes: 5 },
            initialDelay: { minutes: 2 },
            fn: async () => {
              await runNotifier({
                phpipam,
                store,
                notifications,
                recipients,
                logger,
                ...(configuredThresholds
                  ? { thresholds: configuredThresholds }
                  : {}),
              });
            },
          });
          logger.info(
            `ipam: notifications enabled for ${recipients.join(', ')}`,
          );
        }
      },
    });
  },
});
