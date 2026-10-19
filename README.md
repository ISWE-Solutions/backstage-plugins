# ISWE Solutions Backstage plugins

[Backstage](https://backstage.io) plugins for running health-information
infrastructure on Proxmox VE, published to npm as `@iswesolutions/*`.

| Plugin                              | Packages                                                            | What it does                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Proxmox](plugins/proxmox)          | `plugin-proxmox`, `plugin-proxmox-backend`, `plugin-proxmox-common` | Read-only Proxmox VE monitoring: nodes, guests, storage, disks and a "needs attention" view        |
| [DHIS2](plugins/dhis2)              | `plugin-dhis2`, `plugin-dhis2-backend`, `plugin-dhis2-common`       | Create, clone, upgrade, back up and restore DHIS2 instances in Proxmox LXC containers              |
| [IPAM](plugins/ipam)                | `plugin-ipam`, `plugin-ipam-backend`, `plugin-ipam-common`          | phpIPAM front end: subnets, addresses, static-address allocation, DNS checks and search            |
| [Odoo](plugins/odoo-proxmox-runbot) | `odoo-proxmox-runbot`                                               | Odoo instances, Runbot builds, Ansible playbooks and Proxmox LXC containers (preview, sample data) |
| [Monitoring](plugins/monitoring)    | `plugin-monitoring`                                                 | Service health, Prometheus metrics, Grafana dashboards, security alerts and costs (preview, sample data) |

Each plugin's README covers installation and configuration.

Proxmox, DHIS2 and IPAM each come as a frontend, a backend and a shared
`-common` package. The Odoo and Monitoring plugins are single frontend
packages with no backend yet. Their pages are built, but they show sample data
rather than calling Proxmox, Runbot, Ansible, Prometheus or Grafana. Their
READMEs ([Odoo](plugins/odoo-proxmox-runbot), [Monitoring](plugins/monitoring))
list what is built and what is not.

## Development

Requires Node.js 22 or 24. Yarn is vendored in `.yarn/releases`.

```sh
yarn install
yarn tsc          # type-check
yarn build:all    # build every package
yarn test         # run the tests
yarn lint:all
```

## Publishing

Publish with the **npm CLI**, not `yarn npm publish`: Yarn 4 leaves the README
out of the package metadata, so npmjs.com shows "no README".

Build first: a fresh clone has no `dist/`, and publishing without it ships
empty packages. Then publish the `-common` packages first, since the others
depend on them:

```sh
yarn install --immutable
yarn build:release   # tsc (type declarations), then build every package
npm login            # browser sign-in; the token only lasts a few hours
for p in proxmox dhis2 ipam; do for s in -common "" -backend; do
  (cd plugins/$p$s && npm publish --access public) || break 2
done; done
(cd plugins/odoo-proxmox-runbot && npm publish --access public)
(cd plugins/monitoring && npm publish --access public)
```

Bump `version` in every package (and the `^x.y.z` ranges between them) before
each release; npm never accepts a version twice.

## License

[Apache-2.0](LICENSE)
