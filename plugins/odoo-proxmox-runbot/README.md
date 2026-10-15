# @iswesolutions/odoo-proxmox-runbot

A Backstage page for running [Odoo](https://www.odoo.com) on Proxmox VE: Odoo
instances in LXC containers, [Runbot](https://github.com/odoo/runbot) CI
builds, and the Ansible playbooks that provision them.

> **Preview.** The page and its services are a working UI, but the services
> return built-in sample data. Nothing is sent to Proxmox, Runbot or Ansible
> yet, and the plugin reads no configuration. Use it to evaluate the
> workflow, not to manage real instances.

The page has four areas:

- **Instances**: create, start, stop, clone, back up, restore, upgrade and
  delete Odoo instances (Community or Enterprise), with their resources and
  installed modules
- **Runbot**: repositories, branches and builds; trigger, kill and rebuild
  builds, read build logs and test results
- **Ansible**: playbooks (install, configure, backup, restore, upgrade,
  Runbot setup, nginx proxy, PostgreSQL setup), execution history and
  inventory
- **Proxmox cluster**: node CPU, memory and storage usage

## Installation

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

## Exports

| Export                                                                                 | What it is                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `OdooPage`                                                                             | The full page with all four areas                        |
| `OdooInstancesPanel`, `OdooRunbotPanel`, `OdooAnsiblePanel`, `OdooProxmoxClusterPanel` | The individual panels, to embed elsewhere                |
| `odooService`, `runbotService`, `ansibleService`, `proxmoxService` (and their classes) | The data services the page uses (sample data, see above) |
| `odooPlugin`                                                                           | The plugin instance (id `odoo`)                          |
| types such as `OdooInstance`, `RunbotBuild`, `AnsiblePlaybook`, `ProxmoxNode`          | The data model                                           |

## License

[Apache-2.0](../../LICENSE)
