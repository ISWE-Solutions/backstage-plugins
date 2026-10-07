# @iswesolutions/plugin-ipam

A Backstage front end for [phpIPAM](https://phpipam.net): subnets, IP
addresses, VLANs, a subnet map, usage history, DNS checks and a "needs
attention" view, plus a card that shows an entity's addresses on its catalog
page.

Requires [`@iswesolutions/plugin-ipam-backend`](../ipam-backend), which talks
to phpIPAM and enforces permissions.

## Installation

```sh
yarn --cwd packages/app add @iswesolutions/plugin-ipam
```

```tsx
// packages/app/src/App.tsx
import { IPAMPage } from '@iswesolutions/plugin-ipam';

<Route path="/ipam" element={<IPAMPage />} />;
```

```tsx
// packages/app/src/components/catalog/EntityPage.tsx
import { EntityIpamCard } from '@iswesolutions/plugin-ipam';

<Grid item md={6}>
  <EntityIpamCard />
</Grid>;
```

`EntityIpamCard` looks up addresses whose hostname matches the entity name, or
the comma-separated hostnames in the `ipam.iswesolutions.com/hostnames`
annotation. It renders nothing when no address matches.

## Configuration

```yaml
ipam:
  # phpIPAM section that subnets added from the IPAM page go into
  # (default: the first section)
  subnetSection: Datacenter
```

Everything else is configured on the backend.
