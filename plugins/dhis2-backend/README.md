# @iswesolutions/plugin-dhis2-backend

Backend for [`@iswesolutions/plugin-dhis2`](../dhis2). It runs the DHIS2
lifecycle on a Proxmox VE cluster: provisioning, cloning, editing, upgrading,
backups, restores, database moves and decommissioning. Each change runs as a
background job whose sanitised log the page streams. Instances are recorded in
the plugin's database.

## How provisioning works

```
Backstage backend ──► orchestrator host (local exec, or SSH when remote)
                      scripts/create-instance.sh
                        └─ ansible-playbook site.yml
                             pve_lxc        create + start the LXC (Proxmox REST API)
                             lxc_bootstrap  python, sudo, `ansible` user, SSH key
                             postgres       per-instance or shared PostgreSQL
                             dhis2          Java, Tomcat, DHIS2 WAR, dhis.conf
                        └─ scripts/configure-proxy.sh
                             central nginx vhost + Let's Encrypt certificate
```

> **The scripts and playbooks are not part of this npm package.** They live in
> [`plugins/dhis2/scripts`](https://github.com/ISWE-Solutions/backstage-plugins/tree/main/plugins/dhis2/scripts)
> and
> [`plugins/dhis2/ansible`](https://github.com/ISWE-Solutions/backstage-plugins/tree/main/plugins/dhis2/ansible)
> in the GitHub repository. Check them out on the orchestrator host and point
> `dhis2.orchestrator.scriptPath` at `create-instance.sh`.

The orchestrator host needs:

- `ansible-core` 2.13 or later, plus the collections in
  `ansible/requirements.yml`:
  `ansible-galaxy collection install -r ansible/requirements.yml`
- Python `proxmoxer` 2.x and `requests`
- An SSH key pair; the public half is installed in each new container

## Installation

```sh
yarn --cwd packages/backend add @iswesolutions/plugin-dhis2-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@iswesolutions/plugin-dhis2-backend'));
```

## Configuration

```yaml
dhis2:
  orchestrator:
    # 'localhost' runs create-instance.sh on the backend host; any other
    # host is reached over SSH.
    host: localhost
    port: 22
    user: ${DHIS2_ORCHESTRATOR_USER}
    privateKeyFile: ${DHIS2_ORCHESTRATOR_KEY}
    # passphrase: ${DHIS2_ORCHESTRATOR_KEY_PASSPHRASE}
    scriptPath: /opt/backstage-plugins/plugins/dhis2/scripts/create-instance.sh
    # Proxmox node that hosts the central nginx (used by configure-proxy.sh)
    pveHost: pve1
    skipCertbot: false
    # Proxmox REST API used to create and manage containers. The token's
    # user needs PVEVMAdmin (or equivalent) on /.
    apiUrl: ${PROXMOX_API_URL}
    apiUser: ${PROXMOX_USER} # e.g. root@pam
    apiTokenId: ${PROXMOX_TOKEN_ID} # the part after the !
    apiTokenSecret: ${PROXMOX_TOKEN_SECRET}
    validateApiCerts: false
    # Where uploaded database dumps are staged before a restore
    # (default: a directory under the system temp dir)
    restoreStagingDir: /var/lib/backstage/dhis2/restore-staging

  # Optional: give new and cloned containers a static IP from
  # @iswesolutions/plugin-ipam-backend (ipam.allocation must be configured)
  ipamAllocation:
    enabled: true
```

With `host: localhost`, anything left out of `user`, `privateKeyFile` and
`scriptPath` falls back to the current user, the first key in `~/.ssh`, and
common checkout locations of `create-instance.sh`. A remote orchestrator needs
all three.

## API

Routes are under `/api/dhis2` and need a signed-in user. Changes also need a
permission from [`@iswesolutions/plugin-dhis2-common`](../dhis2-common):

| Route                                                                              | Permission               |
| ---------------------------------------------------------------------------------- | ------------------------ |
| `GET /instances`, `GET /instances/reconcile`, `GET /instances/jobs/:id`            | —                        |
| `POST /instances/:id/logs`, `GET /databases/transfers/:id`                         | —                        |
| `POST /instances/provision`, `/instances/next-vmid`, `/restore/upload`             | `dhis2.instance.create`  |
| `POST /databases/test`, `/databases/list`, `/databases/check-compatibility`        | `dhis2.instance.create`  |
| `POST /instances/:id/clone`                                                        | `dhis2.instance.clone`   |
| `POST /instances/:id/edit`, `/instances/:id/upgrade`                               | `dhis2.instance.update`  |
| `POST /instances/:id/lifecycle`, `/instances/:id/backup`, `…/reconcile-live`       | `dhis2.instance.operate` |
| `POST /instances/:id/restore`, `/instances/:id/transfer-database`                  | `dhis2.instance.restore` |
| `POST /instances/:id/decommission`                                                 | `dhis2.instance.delete`  |
| `POST /instances/:id/proxy-files/read`, `…/proxy-files/write`, `…/proxy-logs/tail` | `dhis2.proxy.manage`     |

Database credentials sent to these routes are used for the job and are never
written to job logs.
