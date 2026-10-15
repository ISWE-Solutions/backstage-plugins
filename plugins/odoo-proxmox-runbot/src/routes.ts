import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'odoo',
});

export const instanceRouteRef = createRouteRef({
  id: 'odoo-instance',
  params: ['instanceId'],
});

export const runbotRouteRef = createRouteRef({
  id: 'odoo-runbot',
});

export const ansibleRouteRef = createRouteRef({
  id: 'odoo-ansible',
});
