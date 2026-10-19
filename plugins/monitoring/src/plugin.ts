import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';

import { rootRouteRef } from './routes';

export const monitoringPlugin = createPlugin({
  id: 'monitoring',
  routes: {
    root: rootRouteRef,
  },
});

export const MonitoringPage = monitoringPlugin.provide(
  createRoutableExtension({
    name: 'MonitoringPage',
    component: () =>
      import('./components/MonitoringPage').then(m => m.MonitoringPage),
    mountPoint: rootRouteRef,
  }),
);
