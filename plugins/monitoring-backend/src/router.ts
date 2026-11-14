import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  monitoringSettingsUpdatePermission,
  SETTINGS,
  SettingValue,
  validate,
} from './settings';
import { SettingsStore } from './store';

/**
 *   GET /settings   every signed-in user: { settings: { key: { value, updatedBy, updatedAt } },
 *                   keys: [...], canEdit }
 *   PUT /settings   with monitoring.settings.update: { changes: { key: value | null } } (null removes
 *                   a setting, so app-config applies again); answers like GET
 */
export async function createRouter(options: {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  store: SettingsStore;
}): Promise<express.Router> {
  const { logger, httpAuth, permissions, store } = options;

  const canEdit = async (req: express.Request) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const [decision] = await permissions.authorize(
      [{ permission: monitoringSettingsUpdatePermission }],
      { credentials },
    );
    return { credentials, allowed: decision.result === AuthorizeResult.ALLOW };
  };
  const answer = async (allowed: boolean) => ({
    settings: await store.all(),
    keys: Object.keys(SETTINGS),
    canEdit: allowed,
  });

  const router = Router();
  router.use(express.json());

  router.get('/settings', async (req, res) => {
    const { allowed } = await canEdit(req);
    res.json(await answer(allowed));
  });

  router.put('/settings', async (req, res) => {
    const { credentials, allowed } = await canEdit(req);
    if (!allowed) {
      throw new NotAllowedError(
        'changing Monitoring settings needs monitoring.settings.update',
      );
    }
    const changes = req.body?.changes;
    const problems = validate(changes);
    if (problems.length) throw new InputError(problems.join('; '));
    const by = credentials.principal.userEntityRef;
    await store.apply(changes as Record<string, SettingValue | null>, by);
    logger.info(
      `monitoring settings changed by ${by}: ${JSON.stringify(changes)}`,
    );
    res.json(await answer(true));
  });

  return router;
}
