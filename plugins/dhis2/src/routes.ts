import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'dhis2',
});

export const settingsRouteRef = createRouteRef({
  id: 'dhis2.settings',
});
