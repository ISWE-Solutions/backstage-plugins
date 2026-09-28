import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';

import { rootRouteRef } from './routes';
import { proxmoxApiRef, ProxmoxClientApi } from './services/proxmoxService';

export const proxmoxPlugin = createPlugin({
  id: 'proxmox',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: proxmoxApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new ProxmoxClientApi(discoveryApi, fetchApi),
    }),
  ],
});

export const ProxmoxPage = proxmoxPlugin.provide(
  createRoutableExtension({
    name: 'ProxmoxPage',
    component: () =>
      import('./components/ProxmoxPage/ProxmoxPage').then(m => m.ProxmoxPage),
    mountPoint: rootRouteRef,
  }),
);
