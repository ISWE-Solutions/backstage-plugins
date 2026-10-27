# ISWE Runbot backend

Continuous integration for Odoo repositories inside Backstage, modelled on
[odoo/runbot](https://github.com/odoo/runbot). The page is the **Runbot**
tab of `@iswesolutions/odoo-proxmox-runbot`. This package is the leader and
the API. Builds run on separate **builder** hosts with Docker, installed by
the `runbot-builder` playbook in that package's `ansible/` folder.

## Concepts

The concepts are runbot's:

|                |                                                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**    | Repositories built together, e.g. _ISWE Odoo 19_: odoo/odoo, iswe_meal_addons, iswe_sdp_addons, ZRA-Smart-Invoice-Odoo19. It has **base branches** (`19.0`) and a **master base** for other branch names                                                                                                                    |
| **Repository** | A GitHub repository. One per project provides `odoo-bin` (odoo/odoo). Only its base branches are read, never its pull requests. A repository's default branch, when it isn't a version name (`main`), joins the master base bundle                                                                                          |
| **Bundle**     | All branches with the same name across a project's repositories, plus pull requests (by head branch name). Base bundles are the version branches                                                                                                                                                                            |
| **Trigger**    | What to build when a tested repository gets a commit: install its modules (patterns, exclusions) with the dependency repositories, run their tests (`--test-tags`), with or without demo data, with a timeout, in Docker or a Proxmox container (see [Executors](#executors)). Reports the GitHub status `ci/runbot-<name>` |
| **Batch**      | The commits of a bundle at one moment. Repositories without a branch in the bundle take the base bundle's commit. It waits `batchDelay` seconds (default 60) for related pushes, then creates one build per trigger                                                                                                         |
| **Build**      | One trigger on one set of commits. Identical requests reuse the existing build. A newer batch on a feature branch skips the older batch's builds that haven't started; base bundles keep them                                                                                                                               |

**What creates builds:** as in runbot, only commits to a trigger's tested
repositories. A new commit to a dependency (odoo 19.0) is used by the next
build, not built on its own.

**Results:**

| Result     | When                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| **ko**     | A non-zero exit, any ERROR or CRITICAL log line (failing tests), or a timeout |
| **warn**   | Any WARNING line (apart from slow-test notices)                               |
| **killed** | A user stopped it                                                             |
| **ok**     | None of the above                                                             |

## Setup

```sh
yarn --cwd packages/backend add @iswesolutions/plugin-odoo-runbot-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@iswesolutions/plugin-odoo-runbot-backend'));
```

```yaml
# app-config.production.yaml
backend:
  auth:
    externalAccess:
      # the builders' token: may only call this plugin
      - type: static
        options:
          token: ${RUNBOT_BUILDER_TOKEN} # at least 24 characters
          subject: odoo-runbot-builder
        accessRestrictions:
          - plugin: odoo-runbot

odooRunbot:
  github:
    token: ${RUNBOT_GITHUB_TOKEN} # optional: defaults to the github.com integration's token
  pollSeconds: 60
```

The **GitHub token** must be able to read the repositories and write commit
statuses. For private repositories, use a classic token with the `repo`
scope, or a fine-grained token with Contents read and Commit statuses write.

**Permissions** (grant them with RBAC; reading is open to signed-in users):

- `odoo-runbot.configure`: projects, repositories and triggers.
- `odoo-runbot.build.manage`: rebuild, kill, and force a new batch.

## Builders

```sh
cd node_modules/@iswesolutions/odoo-proxmox-runbot/ansible   # or a checkout of backstage-plugins
ansible-playbook -i inventory.yml playbooks/runbot-builder.yml -l runbot-builder-1 \
  -e runbot_builder_url=https://backstage.example.com/api/odoo-runbot \
  -e runbot_builder_token=$RUNBOT_BUILDER_TOKEN -e runbot_builder_github_token=$GITHUB_TOKEN
```

**What a builder is:** a host (a VM, for Docker) running the agent
(`odoo-runbot-builder.service`). Each worker runs one build at a time.

**What it does per build:**

1. Claims a pending build and checks everything it was sent.
2. Fetches the exact commits into a cache, and exports them with
   `git archive`.
3. Builds or reuses a Docker image for the Odoo version and requirements.
   The image has Python dependencies, wkhtmltopdf and Chrome for tours.
4. Runs `odoo-bin -i <modules> --test-enable --stop-after-init` against the
   host's PostgreSQL, in a container with no capabilities and with memory
   and process limits.
5. Streams the log back, reports the result, and drops the database and
   files.

**Kills and outages:** a kill request reaches the builder at its next
heartbeat, within 10 seconds. Builds on a builder that stops reporting for 5
minutes go back in the queue.

**Security:** builds execute the repositories' code. Only add repositories
whose authors you trust, and keep builders on a network where a build can't
reach anything sensitive. The `runbot` database role can create databases
but is not a superuser.

## Executors

Each trigger chooses where its builds run (`executor`, in **Repositories and
triggers**). The executor is part of the build's parameters, so a Docker build
and a container build are never reused for each other. A builder only claims
builds of the executors it lists (`RUNBOT_EXECUTORS`).

|                                | `docker` (default)                          | `proxmox`                                                                                     |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **The build runs in**          | A container on the builder VM               | A short-lived LXC container, linked-cloned from the Odoo version's template on a Proxmox node |
| **Isolation**                  | Build code stays inside the VM              | Build code runs on the node's kernel (unprivileged container)                                 |
| **Database**                   | The builder VM's PostgreSQL                 | Its own PostgreSQL, inside the container                                                      |
| **Addons' `requirements.txt`** | Baked into an image per set of requirements | Installed in the container at the start of each build                                         |
| **The builder needs**          | Docker                                      | A Proxmox API token limited to a pool, one VMID and one reserved IP per worker, and templates |

**How a proxmox build runs:**

1. Each worker has a fixed slot: VMID `first_vmid + n` and the n-th
   address of `ips`.
2. It removes any leftover container in its slot. It only ever stops or
   deletes containers tagged `runbot-build`; anything else in the slot is an
   error.
3. It linked-clones the version's template, sets the address, memory and
   cores, and starts it.
4. It copies the sources in over SSH. Root in the templates trusts only the
   builder's key.
5. It runs `odoo-bin`, the same as with Docker.
6. It destroys the container.

**Setting it up:**

1. Create a resource pool `runbot` and an API token (for example
   `runbot@pve!builder`), with privileges only on that pool and the
   templates: `VM.Clone`, `VM.Allocate`, `VM.Config.*`, `VM.PowerMgmt`,
   `VM.Audit`, and `Datastore.AllocateSpace` on the storage.
2. Reserve one IP per worker in IPAM, and pick VMIDs in the 700–899 range
   with no backup history. Exclude the pool from backups.
3. Install or update the builder with `runbot_builder_executors: [docker, proxmox]`
   and `runbot_builder_proxmox` set. It prints the builder's public key.
4. Make a template per Odoo version with `runbot-template.yml`, passing that
   key as `runbot_template_ssh_key`. Use VMIDs in the 9000–9999 range, e.g.
   9019 for 19.0.
5. On the Runbot tab, set the trigger's executor to **Proxmox LXC**.

**Refreshing templates:** re-run `runbot-template.yml` when Odoo's
requirements change. Docker images follow the requirements file by
themselves.

## API

Under `/api/odoo-runbot`:

| Method and path                                                                                       | Who                        |                                                         |
| ----------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| `GET /projects`, `/projects/:id`                                                                      | users                      | Projects; one with its repos, triggers and build counts |
| `GET /projects/:id/bundles?search=`                                                                   | users                      | Bundles, base bundles first, with their latest batch    |
| `GET /bundles/:id`, `/batches/:id`                                                                    | users                      | A bundle's recent batches; one batch                    |
| `GET /builds`, `/builds/:id`, `/builds/:id/logs?after=&levels=`                                       | users                      | Builds and logs                                         |
| `GET /hosts`, `/stats`                                                                                | users                      | Builders; build counts                                  |
| `POST /projects`, `/repos`, `/triggers`; `PATCH /repos/:id`, `/triggers/:id`                          | `odoo-runbot.configure`    | Configuration                                           |
| `POST /bundles/:id/force`, `/builds/:id/rebuild`, `/builds/:id/kill`                                  | `odoo-runbot.build.manage` | Build actions                                           |
| `POST /builder/heartbeat`, `/builder/claim`, `/builder/builds/:id/logs`, `/builder/builds/:id/result` | the builder token          | Builders                                                |

## Not yet

Planned, in this order:

1. **Running builds:** keeping a build's database up as a demo instance on a
   subdomain. This needs wildcard DNS and a wildcard certificate.
2. **More runbot features:** garbage collection policies, build error
   tracking across builds, statistics, coverage, multi-step configurations,
   and nightly and custom triggers.
3. **Mergebot:** `r+` and `retry` commands in PR comments, required
   statuses, staging branches, fast-forward merges.
4. **Forward-port:** porting merged PRs to the next version branch.
