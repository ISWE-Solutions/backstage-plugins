# ISWE Solutions Backstage plugins

[Backstage](https://backstage.io) plugins for running health-information
infrastructure on Proxmox VE, published to npm as `@iswesolutions/*`.

| Plugin                     | Packages                                                            | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Proxmox](plugins/proxmox) | `plugin-proxmox`, `plugin-proxmox-backend`, `plugin-proxmox-common` | Read-only Proxmox VE monitoring: nodes, guests, storage, disks and a "needs attention" view |
| [DHIS2](plugins/dhis2)     | `plugin-dhis2`, `plugin-dhis2-backend`, `plugin-dhis2-common`       | Create, clone, upgrade, back up and restore DHIS2 instances in Proxmox LXC containers       |
| [IPAM](plugins/ipam)       | `plugin-ipam`, `plugin-ipam-backend`, `plugin-ipam-common`          | phpIPAM front end: subnets, addresses, static-address allocation, DNS checks and search     |

Each plugin's README covers installation and configuration.

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

Packages are published from this repository. Build first: a fresh clone has no
`dist/`, and publishing without it ships empty packages. Then publish the
`-common` packages first, since the others depend on them:

```sh
yarn install --immutable
yarn build:release   # tsc (type declarations), then build every package
for p in proxmox dhis2 ipam; do for s in -common "" -backend; do
  (cd plugins/$p$s && yarn npm publish --access public) || break 2
done; done
```

## License

[Apache-2.0](LICENSE)
