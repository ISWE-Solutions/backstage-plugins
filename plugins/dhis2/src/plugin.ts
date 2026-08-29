import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';

export const dhis2Plugin = createPlugin({
  id: 'dhis2',
  routes: {
    root: rootRouteRef,
  },
});

export const DHIS2Page = dhis2Plugin.provide(
  createRoutableExtension({
    name: 'DHIS2Page',
    component: () => import('./components/DHIS2Page').then(m => m.DHIS2Page),
    mountPoint: rootRouteRef,
  }),
);
