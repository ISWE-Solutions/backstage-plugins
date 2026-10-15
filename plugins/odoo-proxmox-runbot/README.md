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

**New instance** opens a form for:

| Field                      | Notes                                      |
| -------------------------- | ------------------------------------------ |
| Instance name and domain   | The container hostname comes from the name |
| Odoo version               | 14.0 to 18.0                               |
| Edition                    | Community or Enterprise                    |
| Proxmox node               | Where the container is created             |
| Workers                    | Odoo worker processes                      |
| CPU cores, memory, storage | The container's resources (MB and GB)      |
| Database name, password    | The instance's PostgreSQL database         |
| Admin password             | Odoo's master password                     |

Creating an instance is meant to run these steps in order:

1. Take the next free VMID from Proxmox.
2. Create an unprivileged Ubuntu 24.04 LXC container on the chosen node
   (`vmbr0`, DHCP).
3. Run the `odoo-install` playbook with the version, edition, workers,
   database and addons.
4. Run the `nginx-proxy` playbook to put the instance behind nginx with TLS
   (port 8069, longpolling on 8072).

If a step fails after the container exists, the error names the container so
it can be cleaned up or provisioning retried.

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

No `app-config.yaml` settings, backend plugin or proxy endpoints are needed.

## Exports

| Export                                                                                 | What it is                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `OdooPage`                                                                             | The full page                                                   |
| `OdooInstancesPanel`, `OdooRunbotPanel`, `OdooAnsiblePanel`, `OdooProxmoxClusterPanel` | The individual panels, to embed elsewhere (an entity page, say) |
| `odooService`, `runbotService`, `ansibleService`, `proxmoxService`                     | Singleton instances of the services below                       |
| `OdooService`, `RunbotService`, `AnsibleService`, `ProxmoxService`                     | The service classes                                             |
| `odooPlugin` (also exported as `plugin`)                                               | The plugin instance, id `odoo`                                  |
| Types                                                                                  | See [Data model](#data-model)                                   |

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

| Area    | Types                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Odoo    | `OdooInstance`, `OdooInstanceStatus`, `OdooEdition`, `CreateOdooInstanceRequest`, `UpdateOdooInstanceRequest`, `OdooModule`, `OdooDashboardStats` |
| Runbot  | `RunbotRepo`, `RunbotBranch`, `RunbotBuild`, `RunbotBuildState`, `RunbotBuildResult`, `RunbotBuildLog`, `RunbotConfig`                            |
| Ansible | `AnsiblePlaybook`, `AnsiblePlaybookStatus`, `AnsiblePlaybookExecution`, `AnsibleInventoryHost`, `AnsibleRole`                                     |
| Proxmox | `ProxmoxNode`, `LXCContainer`, `LXCConfig`, `ProxmoxTask`                                                                                         |
| Generic | `ApiResponse<T>`, `PaginatedResponse<T>`                                                                                                          |

## Status

| Part                               | State                                         |
| ---------------------------------- | --------------------------------------------- |
| Page, tabs, panels and create form | Built                                         |
| Data model and service interfaces  | Built                                         |
| Proxmox, Runbot and Ansible calls  | Not built: every service returns sample data  |
| Backend plugin and configuration   | Not built                                     |
| Permissions                        | None: anyone who can open the page can use it |
| Tests                              | None                                          |

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
