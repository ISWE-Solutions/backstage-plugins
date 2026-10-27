import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { RunbotClient, runbotApiRef } from './api/runbotApi';

export const odooPlugin = createPlugin({
  id: 'odoo',
  apis: [
    createApiFactory({
      api: runbotApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new RunbotClient(deps),
    }),
  ],
  routes: {
    root: rootRouteRef,
  },
});

export const OdooPage = odooPlugin.provide(
  createRoutableExtension({
    name: 'OdooPage',
    component: () => import('./components/OdooPage').then(m => m.OdooPage),
    mountPoint: rootRouteRef,
  }),
);
