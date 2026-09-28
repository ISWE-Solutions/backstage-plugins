import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef, settingsRouteRef } from './routes';

export const dhis2Plugin = createPlugin({
  id: 'dhis2',
  routes: {
    root: rootRouteRef,
    settings: settingsRouteRef,
  },
});

export const DHIS2Page = dhis2Plugin.provide(
  createRoutableExtension({
    name: 'DHIS2Page',
    component: () => import('./components/DHIS2Page').then(m => m.DHIS2Page),
    mountPoint: rootRouteRef,
  }),
);

export const DHIS2SettingsPage = dhis2Plugin.provide(
  createRoutableExtension({
    name: 'DHIS2SettingsPage',
    component: () =>
      import('./components/DHIS2SettingsPage').then(m => m.DHIS2SettingsPage),
    mountPoint: settingsRouteRef,
  }),
);
