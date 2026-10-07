# @iswesolutions/plugin-dhis2

Run [DHIS2](https://dhis2.org) instances from Backstage. Each instance is a
Proxmox VE LXC container behind a shared nginx reverse proxy with Let's Encrypt
TLS. From the `/dhis2` page you can:

- **create** instances: pick the DHIS2 version, resources, Proxmox node and
  database (in the container or on a shared PostgreSQL server), optionally
  starting from a database dump
- **clone**, **edit** resources and settings, and **upgrade** to newer DHIS2
  releases and hotfixes
- **start, stop, restart** and **back up** instances, and **restore** a database
  or move it to another server
- **decommission** an instance, optionally taking a `pg_dump` first
- follow every job live, replay past runs, and read instance and nginx logs

The page has four tabs: **Dashboard** (cluster and instance overview),
**DHIS2 Instances**, **Settings** (Proxmox clusters, proxy and defaults) and
**Logs** (the orchestration history).

The work is done by
[`@iswesolutions/plugin-dhis2-backend`](../dhis2-backend), which drives an
Ansible playbook against the Proxmox REST API. Start there: its README lists
what the orchestrator host needs.

## Installation

```sh
yarn --cwd packages/app add @iswesolutions/plugin-dhis2
```

```tsx
// packages/app/src/App.tsx
import { DHIS2Page } from '@iswesolutions/plugin-dhis2';

<Route path="/dhis2" element={<DHIS2Page />} />;
```

The page calls Proxmox and the DHIS2 release list through the Backstage proxy:

```yaml
proxy:
  endpoints:
    '/proxmox':
      target: ${PROXMOX_API_URL}
      changeOrigin: true
      secure: false # PVE ships a self-signed certificate
      credentials: require
      headers:
        Authorization: PVEAPIToken=${PROXMOX_USER}!${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}
    '/dhis2-releases':
      target: https://releases.dhis2.org
      changeOrigin: true
```

Keep `credentials: require` on `/proxmox`. The proxy adds the API token to
every request, so letting unauthenticated callers through would expose the
Proxmox API to anyone who can reach Backstage.

## Configuration

Users can change the Settings tab, which is saved in their browser. Until they
do, the page uses these defaults, which you can set for your deployment:

```yaml
dhis2:
  settingsDefaults:
    proxmox:
      apiUrl: https://pve.example.com:8006
      defaultNode: pve1
      searchDomain: example.org
      nameserver: 10.0.0.53
    proxy:
      mode: path # or subdomain
      baseDomain: dhis2.example.org # instances at dhis2.example.org/<name>
      host: proxy.example.org # SSH host of the nginx proxy
    dhis2:
      defaultVersion: '2.40.3'
      defaultCpu: 4
      defaultMemoryMb: 16384
      defaultStorageGb: 40
    # Stored browser values to discard in favour of the defaults above,
    # e.g. a host that once shipped as a default by mistake
    replaceStoredValues:
      proxy:
        host: [old-proxy.example.org]
```

This block is sent to the browser, so it accepts no passwords or tokens. See
[`config.d.ts`](config.d.ts) for every option.

## Permissions

Anyone signed in can view instances, jobs and logs. Changes need the
permissions in [`@iswesolutions/plugin-dhis2-common`](../dhis2-common)
(`dhis2.instance.create`, `.clone`, `.update`, `.operate`, `.restore`,
`.delete` and `dhis2.proxy.manage`). The page hides or disables actions the
user isn't allowed to take.
