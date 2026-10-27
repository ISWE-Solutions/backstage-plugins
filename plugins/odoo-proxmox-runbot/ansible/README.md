# Ansible playbooks for Odoo instances

The playbooks the Odoo page runs, shipped in the same package as the page.
The variable names match what the create form sends
(`installPlaybookVars()` in `src/odooConfig.ts`), so a request from Backstage
and a hand-written inventory entry use the same settings.

| Playbook              | What it does                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `odoo-install.yml`    | Creates the guest on the chosen platform, then installs Odoo in it: system packages, wkhtmltopdf, the code (Odoo, Enterprise, addons), Python, the database, `odoo.conf`, the systemd service, and first-time module installation |
| `odoo-configure.yml`  | Rewrites `odoo.conf` and the service unit, and restarts Odoo if they changed                                                                                                                                                      |
| `nginx-proxy.yml`     | nginx in front of Odoo, with WebSocket. TLS from Let's Encrypt, your own certificate, or none when another proxy terminates it                                                                                                    |
| `odoo-backup.yml`     | Backs up the database (`pg_dump -Fc`), filestore, `odoo.conf` and the code revisions, and keeps the newest 7                                                                                                                      |
| `odoo-restore.yml`    | Restores a backup over the live database and filestore, after taking a safety backup                                                                                                                                              |
| `odoo-upgrade.yml`    | Backs up, moves the code to its configured revisions, updates modules (`-u all`) and restarts                                                                                                                                     |
| `odoo-remove.yml`     | Deletes the guest and everything in it                                                                                                                                                                                            |
| `runbot-builder.yml`  | A builder for the ISWE Runbot: Docker, a local PostgreSQL for build databases, and the builder agent. With `runbot_builder_executors: [docker, proxmox]` it also sets up the Proxmox executor and prints the builder's SSH key    |
| `runbot-template.yml` | An LXC template per Odoo version for the runbot's Proxmox executor: the Odoo instance packages, wkhtmltopdf, Chrome, a local PostgreSQL and a venv with that version's requirements; root trusts only the builder                 |

All of them are idempotent: running one again only changes what differs.

## Platforms

`odoo_platform` chooses where the instance runs. The `odoo` role is the same
on every platform; only how the guest is created and reached differs.

| `odoo_platform` | The guest                                                                                                 | How Ansible reaches it                                            | You provide                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `proxmox`       | An unprivileged LXC container (Ubuntu template, `nesting=1` for systemd), created through the Proxmox API | SSH as root to its static address, optionally through a jump host | API token, node, bridge, a static IP (`odoo_proxmox_ip`), the controller's SSH public key |
| `lxd`           | An LXD container from Ubuntu's cloud images                                                               | `lxc exec` from the controller                                    | LXD on the controller, or a remote (`odoo_lxd_remote`)                                    |
| `docker`        | A Docker container whose PID 1 is systemd, with named volumes for the code, filestore and PostgreSQL      | `docker exec`                                                     | A Docker host, and an image with systemd (`odoo_docker_images`)                           |
| `ssh`           | An existing machine; nothing is created or deleted                                                        | SSH as a sudoer (`ansible_host`, `ansible_user`)                  | The machine                                                                               |

Only `odoo-install.yml` creates a guest (`odoo_guest_create`). The other
playbooks connect to an existing guest and fail if it isn't there, so a typo
in a host name can't create an empty container.

**Supported operating systems:** Ubuntu 24.04 and 22.04. Odoo 19.0 needs
24.04, 16.0 needs 22.04, and 17.0 and 18.0 run on either. The role checks
this before changing anything.

## Running them

```sh
cd ansible
ansible-galaxy collection install -r requirements.yml
cp inventory.example.yml inventory.yml   # one host per instance
ansible-playbook -i inventory.yml playbooks/odoo-install.yml -l kugula-erp
ansible-playbook -i inventory.yml playbooks/nginx-proxy.yml -l kugula-erp
```

Requirements: Ansible 2.15 or later on the controller, plus the
`community.general`, `community.docker`, `community.postgresql` and
`ansible.posix` collections.

To run only part of the installation, use its tags:

- `odoo_packages`
- `odoo_wkhtmltox`
- `odoo_sources`
- `odoo_postgresql`
- `odoo_config`
- `odoo_service`
- `odoo_init`

To preview what would change, add `--check --diff`.

## Settings

**Defaults:** every variable and its default is in
`roles/odoo_guest/defaults/main.yml` (the platform),
`roles/odoo/defaults/main.yml` (Odoo) and `roles/odoo_nginx/defaults/main.yml`
(nginx). `inventory.example.yml` shows one instance on each platform.

**Code:**

- `odoo_repo_url` and `_rev` for Odoo.
- `odoo_enterprise_repo_url` and `_rev`, for the enterprise edition.
- `odoo_addons_repos`: a list of `{name, url, rev, depth, subdir}`.
  - `addons_path` is Enterprise, then the addons repositories in order, then
    Odoo's own addons. Set `odoo_config_addons_path` to override it.
  - A branch or tag is cloned shallow. A commit hash needs `depth: 0`.

**Private repositories:** set `odoo_git_key_file` to a deploy key on the
controller. Otherwise the role generates a key on the instance and prints its
public key; add that as a read-only deploy key on each private repository,
then run the playbook again.

**Database:**

- `odoo_db_placement: local` installs PostgreSQL in the guest.
- `odoo_db_placement: cluster` uses a shared server instead, and needs:

  - `odoo_config_db_host`, `_port` and `_sslmode`
  - an account that can create roles and databases (`odoo_db_admin_user`,
    `odoo_db_admin_password`)
  - the server's CA certificate (`odoo_db_ca_cert`, PEM) for `verify-full`

  The role creates `<db>_app` (no superuser, no `CREATEDB`), a database owned
  by it, and the `unaccent` extension.

**odoo.conf:** one `odoo_config_<option>` per setting (`workers`,
`limit_memory_soft`, `list_db`, `dbfilter`, …), plus `odoo_config_custom` for
anything else.

**Production safeguards:** in production the role refuses `list_db`, a
`dbfilter` of `.*`, and demo data.

**Odoo version:** `odoo_upgrade_target_version` must be the instance's own
major version. Moving from 17.0 to 18.0 is a data migration (OpenUpgrade or
Odoo's upgrade service), not an update.

**Confirmations:** `odoo-restore.yml` in production, and `odoo-remove.yml`
always, need a confirmation variable set to the instance's name
(`odoo_restore_confirm`, `odoo_remove_confirm`).

## Secrets

**Generated passwords:** the master password and the database password are
generated on the controller the first time and reused afterwards. They're
stored in `odoo_secrets_dir/<instance>/` with mode 0600. The default is
`ansible/.secrets/`, or `$ODOO_SECRETS_DIR` if set, and it's git-ignored. To
use your own master password, set `odoo_admin_password`.

**Never in logs:** the tasks that handle secrets run with `no_log`, and the
backup folder (which holds `odoo.conf`) is root-only.

**Credentials you supply** (the Proxmox token, the cluster admin password,
the SMTP password) belong in Ansible Vault or the controller's environment,
not in the inventory. The example inventory reads them with
`lookup('env', …)`.

## Checks

`.ansible-lint` uses the `production` profile:

```sh
ansible-lint
ansible-playbook -i inventory.example.yml --syntax-check playbooks/*.yml
```
