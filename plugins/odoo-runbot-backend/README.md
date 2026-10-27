# ISWE Runbot backend

Continuous integration for Odoo repositories inside Backstage, modelled on
[odoo/runbot](https://github.com/odoo/runbot). The page is the **Runbot**
tab of `@iswesolutions/odoo-proxmox-runbot`. This package is the leader and
the API. Builds run on separate **builder** hosts with Docker, installed by
the `runbot-builder` playbook in that package's `ansible/` folder.

## Concepts

The concepts are runbot's:

|                |                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**    | Repositories built together, e.g. _ISWE Odoo 19_: odoo/odoo, iswe_meal_addons, iswe_sdp_addons, ZRA-Smart-Invoice-Odoo19. It has **base branches** (`19.0`) and a **master base** for other branch names                                                    |
| **Repository** | A GitHub repository. One per project provides `odoo-bin` (odoo/odoo). Only its base branches are read, never its pull requests. A repository's default branch, when it isn't a version name (`main`), joins the master base bundle                          |
| **Bundle**     | All branches with the same name across a project's repositories, plus pull requests (by head branch name). Base bundles are the version branches                                                                                                            |
| **Trigger**    | What to build when a tested repository gets a commit: install its modules (patterns, exclusions) with the dependency repositories, run their tests (`--test-tags`), with or without demo data, with a timeout. Reports the GitHub status `ci/runbot-<name>` |
| **Batch**      | The commits of a bundle at one moment. Repositories without a branch in the bundle take the base bundle's commit. It waits `batchDelay` seconds (default 60) for related pushes, then creates one build per trigger                                         |
| **Build**      | One trigger on one set of commits. Identical requests reuse the existing build. A newer batch on a feature branch skips the older batch's builds that haven't started; base bundles keep them                                                               |

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
