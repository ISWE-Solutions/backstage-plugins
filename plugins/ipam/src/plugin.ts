import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';

import { rootRouteRef } from './routes';

export const ipamPlugin = createPlugin({
  id: 'ipam',
  routes: {
    root: rootRouteRef,
  },
});

export const IPAMPage = ipamPlugin.provide(
  createRoutableExtension({
    name: 'IPAMPage',
    component: () =>
      import('./components/IPAMPage').then(m => m.IPAMPage),
    mountPoint: rootRouteRef,
  }),
);
