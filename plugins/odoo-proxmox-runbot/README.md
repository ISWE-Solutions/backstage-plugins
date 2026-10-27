# @iswesolutions/odoo-proxmox-runbot

A Backstage page for running [Odoo](https://www.odoo.com) on Proxmox VE. It
brings together three things an Odoo hosting team juggles:

- **Odoo instances**, each in its own Proxmox LXC container
- **[Runbot](https://github.com/odoo/runbot) CI builds** for the Odoo,
  Enterprise and custom-addon repositories
- **Ansible playbooks** that install, configure, back up and upgrade those
  instances

> **Preview.** The page and its services are a working UI, but the services
> return built-in sample data. Nothing is sent to Proxmox, Runbot or Ansible
> yet, and the plugin reads no configuration. Use it to evaluate the
> workflow, not to manage real instances. See [Status](#status).

## The page

The page has five tabs.

| Tab           | What it shows                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard** | Counts of instances, running instances, Runbot builds and Proxmox nodes; cluster CPU, memory and storage usage; recent builds; and a table of instances to open  |
| **Instances** | Every instance with its status (running, stopped, provisioning), version, edition, node and resources. Actions: start, stop, back up, clone, settings and delete |
| **Runbot**    | Builds with their commit, author, state, result, duration and test coverage. Actions: kill a running build, rebuild a finished one                               |
| **Ansible**   | Playbooks and their execution history: status, duration and per-host stats (ok, changed, failed, unreachable). Run a playbook from here                          |
| **Proxmox**   | Each cluster node's CPU, memory and storage usage                                                                                                                |

### Creating an instance

**New instance** opens a five-step form. The **Review** step lists anything
that must be fixed, and **Create instance** stays disabled until it's
clean.

1. **Basics:**
   - name: gives the container hostname
   - domain
   - **environment:** production, staging or development
   - **Odoo version** and **operating system**: only valid pairs are offered
     (see below)
   - edition and Proxmox node
   - CPU cores, memory and storage
2. **Sources:** where the code comes from.
   - Odoo's repository and branch, tag or commit.
   - For Enterprise, its repository, or your mirror of it.
   - Any number of **addons repositories**, each with a revision and an
     optional sub-folder. Their order is the search order.
   - Repositories can be **picked from the catalog**: any Component tagged
     `odoo` that has a `github.com/project-slug` annotation.
   - The resulting `addons_path` is shown below the list: Enterprise, then
     the addons repositories in order, then Odoo's own addons.
3. **Database:** a **shared PostgreSQL cluster** (recommended) or a local
   server in the container.
   - The cluster follows the environment: production uses `prod`, staging
     `stg`, development `dev`.
   - The role is `<database>_app`, with a generated password.
   - The connection uses `sslmode=verify-full`.
4. **Configuration:** `odoo.conf`, in groups: performance, security, email,
   logging and other, plus free-form options.
   - The settings are **suggested from the container's size and the
     environment** until you edit them. **Suggest from size** recalculates
     them.
5. **Review:** problems, then the resulting `odoo.conf`. Secrets appear as
   placeholders.

**Versions and operating systems:**

| Odoo       | Runs on                    | Note                                                     |
| ---------- | -------------------------- | -------------------------------------------------------- |
| 19.0       | Ubuntu 24.04 (Python 3.12) |                                                          |
| 18.0, 17.0 | Ubuntu 24.04 or 22.04      |                                                          |
| 16.0       | Ubuntu 22.04 (Python 3.10) | No longer supported by Odoo S.A.; allowed with a warning |

**Suggested settings:**

- **Workers:** 2 × cores + 1, capped by memory: 512 MB is kept for the
  system, and each worker is allowed about 400 MB on average.
  Development runs threaded (0 workers), which is simpler to debug.
- **Memory limits:** 80% of the container's memory, shared across workers
  and cron threads, between 640 MB and 2 GB each. The hard limit is 1.25 ×
  the soft limit.
- **Time limits:** 600 s CPU and 1,200 s real, so large imports and reports
  finish.
- **Connections:** 16 per process on a shared cluster, 64 on a local server.

**Safe defaults, and what the form enforces:**

| Setting                      | Production                                                                    | Staging                 | Development |
| ---------------------------- | ----------------------------------------------------------------------------- | ----------------------- | ----------- |
| `list_db` (database manager) | off; **error** if on                                                          | off; warning if on      | on          |
| `dbfilter`                   | `^%d$`; **error** if `.*`                                                     | `^%d$`; warning if `.*` | `.*`        |
| Demo data                    | none; **error** if loaded                                                     | none                    | allowed     |
| `proxy_mode`                 | on (behind nginx); warning if off                                             | on                      | on          |
| Master password              | generated and stored, never shown. A typed one must be at least 16 characters | same                    | same        |

**Database names on a shared cluster** follow `<owner>_<app>[_<part>]`:

- lowercase snake_case, at most 40 characters
- no environment in the name (`_prod`, `_test`, `_dev`…): the cluster is
  the environment
- no version or year; `_demo` and `_training` never in production

These are errors on a cluster, and only advice for a local database.

**Other checks:**

- an addons branch for a different Odoo version
- a cluster that belongs to another environment
- memory limits that overcommit the container
- the Enterprise edition without an Enterprise repository

Creating an instance is meant to run these steps in order:

1. Take the next free VMID from Proxmox.
2. Create an unprivileged container from the chosen OS's template.
3. Run the `odoo-install` playbook. Its variables come from
   `installPlaybookVars()`:
   - `odoo_version`, `odoo_repo_url`/`_rev`, `odoo_enterprise_repo_url`/`_rev`
   - `odoo_addons_repos` and `odoo_config_addons_path`
   - the database connection, with `odoo_install_postgresql` true only for
     a local server
   - one `odoo_config_<option>` per `odoo.conf` setting
4. Run the `nginx-proxy` playbook to put the instance behind nginx with TLS
   (port 8069, WebSocket/longpolling on 8072).

If a step fails after the container exists, the error names the container so
it can be cleaned up or provisioning retried.

The rules live in `src/odooConfig.ts` as pure functions, and are exported
for reuse:

- `ODOO_VERSIONS`, `OS_INFO`
- `computeAddonsPath`, `suggestServerConfig`
- `checkDatabaseName`, `validateCreateRequest`
- `renderOdooConf`, `installPlaybookVars`

### Playbooks

| Playbook           | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `odoo-install`     | PostgreSQL, Python dependencies, Odoo source, systemd service, wkhtmltopdf |
| `odoo-configure`   | `odoo.conf`, addons paths, workers and logging                             |
| `odoo-backup`      | Database, filestore and configuration                                      |
| `odoo-restore`     | Restore a backup                                                           |
| `odoo-upgrade`     | Back up, update the source, migrate the database and update modules        |
| `runbot-setup`     | Runbot module, workers, nginx and build environment                        |
| `nginx-proxy`      | TLS termination, WebSocket longpolling, static files                       |
| `postgresql-setup` | Tuning, users, backups and replication                                     |

These are the playbooks the UI lists. They are not shipped in this package.

## Installation

The package is a frontend plugin for the legacy (non-`/alpha`) Backstage
frontend system.

```sh
yarn --cwd packages/app add @iswesolutions/odoo-proxmox-runbot
```

```tsx
// packages/app/src/App.tsx
import { OdooPage } from '@iswesolutions/odoo-proxmox-runbot';

<Route path="/odoo" element={<OdooPage />} />;
```

```tsx
// packages/app/src/components/Root/Root.tsx
import CloudIcon from '@material-ui/icons/Cloud';

<SidebarItem icon={CloudIcon} to="odoo" text="Odoo" />;
```

No `app-config.yaml` settings, backend plugin or proxy endpoints are needed. The create form reads the software catalog
(`catalogApiRef`, present in every Backstage app) for addons repository
suggestions; if the catalog can't be read, repositories are typed in.

## Exports

| Export                                                                                                                                                        | What it is                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `OdooPage`                                                                                                                                                    | The full page                                                          |
| `OdooInstancesPanel`, `OdooRunbotPanel`, `OdooAnsiblePanel`, `OdooProxmoxClusterPanel`                                                                        | The individual panels, to embed elsewhere (an entity page, say)        |
| `odooService`, `runbotService`, `ansibleService`, `proxmoxService`                                                                                            | Singleton instances of the services below                              |
| `OdooService`, `RunbotService`, `AnsibleService`, `ProxmoxService`                                                                                            | The service classes                                                    |
| `CreateInstanceDialog`                                                                                                                                        | The new-instance form, on its own                                      |
| `ODOO_VERSIONS`, `OS_INFO`, `computeAddonsPath`, `suggestServerConfig`, `checkDatabaseName`, `validateCreateRequest`, `renderOdooConf`, `installPlaybookVars` | The instance rules (see [Creating an instance](#creating-an-instance)) |
| `odooPlugin` (also exported as `plugin`)                                                                                                                      | The plugin instance, id `odoo`                                         |
| Types                                                                                                                                                         | See [Data model](#data-model)                                          |

### Services

All methods are `async`.

| Service          | Methods                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `odooService`    | `getInstances`, `getInstance`, `createInstance`, `updateInstance`, `deleteInstance`, `startInstance`, `stopInstance`, `restartInstance`, `backupInstance`, `restoreInstance`, `upgradeInstance`, `cloneInstance`, `getInstanceModules`, `installModule`, `uninstallModule`, `getAvailableVersions`, `getDashboardStats` |
| `runbotService`  | `getRepos`, `getRepo`, `createRepo`, `updateRepo`, `deleteRepo`, `getBranches`, `getRepoBranches`, `getBranch`, `getBuilds`, `getBranchBuilds`, `getBuild`, `triggerBuild`, `killBuild`, `rebuildBuild`, `getBuildLogs`, `getConfig`, `updateConfig`, `getStats`                                                        |
| `ansibleService` | `getPlaybooks`, `getPlaybook`, `executePlaybook`, `getExecutions`, `getExecution`, `cancelExecution`, `getInventoryHosts`, `getRoles`, `validatePlaybook`, `testConnection`                                                                                                                                             |
| `proxmoxService` | `getNodes`, `getContainers`, `getNodeContainers`, `getContainer`, `createContainer`, `startContainer`, `stopContainer`, `restartContainer`, `deleteContainer`, `cloneContainer`, `resizeDisk`, `getTaskStatus`, `getTemplates`, `getNextVmid`, `execCommand`                                                            |

`odooService` orchestrates the other three: creating, cloning or upgrading an
instance calls `proxmoxService` and `ansibleService`.

### Data model

| Area    | Types                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Odoo    | `OdooInstance`, `OdooInstanceStatus`, `OdooEdition`, `OdooEnvironment`, `OdooOs`, `OdooSources`, `OdooRepoSource`, `OdooAddonsRepo`, `OdooDatabaseSettings`, `OdooDatabasePlacement`, `PostgresCluster`, `PgSslMode`, `OdooServerConfig`, `OdooLogLevel`, `CreateOdooInstanceRequest`, `UpdateOdooInstanceRequest`, `OdooModule`, `OdooDashboardStats` |
| Runbot  | `RunbotRepo`, `RunbotBranch`, `RunbotBuild`, `RunbotBuildState`, `RunbotBuildResult`, `RunbotBuildLog`, `RunbotConfig`                                                                                                                                                                                                                                 |
| Ansible | `AnsiblePlaybook`, `AnsiblePlaybookStatus`, `AnsiblePlaybookExecution`, `AnsibleInventoryHost`, `AnsibleRole`                                                                                                                                                                                                                                          |
| Proxmox | `ProxmoxNode`, `LXCContainer`, `LXCConfig`, `ProxmoxTask`                                                                                                                                                                                                                                                                                              |
| Generic | `ApiResponse<T>`, `PaginatedResponse<T>`                                                                                                                                                                                                                                                                                                               |

## Status

| Part                               | State                                                 |
| ---------------------------------- | ----------------------------------------------------- |
| Page, tabs, panels and create form | Built; the create form checks the request (see above) |
| Data model and service interfaces  | Built                                                 |
| Proxmox, Runbot and Ansible calls  | Not built: every service returns sample data          |
| Backend plugin and configuration   | Not built                                             |
| Permissions                        | None: anyone who can open the page can use it         |
| Tests                              | The instance rules and the create form                |

Connecting it to real systems needs a backend plugin that holds the Proxmox
API token, Runbot credentials and Ansible inventory, with the frontend
services calling that backend instead of returning sample data.

## Development

From the repository root:

```sh
yarn install
yarn tsc
yarn --cwd plugins/odoo-proxmox-runbot build
yarn --cwd plugins/odoo-proxmox-runbot lint
```

## License

[Apache-2.0](../../LICENSE)
