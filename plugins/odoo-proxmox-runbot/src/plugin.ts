import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';

export const odooPlugin = createPlugin({
  id: 'odoo',
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
