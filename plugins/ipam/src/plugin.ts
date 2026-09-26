import {
  createApiFactory,
  createComponentExtension,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';

import { rootRouteRef } from './routes';
import { IPAMService, ipamApiRef } from './services/ipamService';

export const ipamPlugin = createPlugin({
  id: 'ipam',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: ipamApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new IPAMService(discoveryApi, fetchApi),
    }),
  ],
});

export const IPAMPage = ipamPlugin.provide(
  createRoutableExtension({
    name: 'IPAMPage',
    component: () => import('./components/IPAMPage').then(m => m.IPAMPage),
    mountPoint: rootRouteRef,
  }),
);

/** IP addresses for the current catalog entity (hidden when none match) */
export const EntityIpamCard = ipamPlugin.provide(
  createComponentExtension({
    name: 'EntityIpamCard',
    component: {
      lazy: () =>
        import('./components/EntityIpamCard/EntityIpamCard').then(
          m => m.EntityIpamCard,
        ),
    },
  }),
);
