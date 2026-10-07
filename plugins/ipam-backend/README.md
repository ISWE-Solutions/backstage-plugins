# @iswesolutions/plugin-ipam-backend

Backend for [`@iswesolutions/plugin-ipam`](../ipam): a permission-checked
gateway to the phpIPAM API, static-address allocation for new containers, DNS
checks, usage history, a search collator and Backstage notifications for new
IPAM issues.

## Installation

```sh
yarn --cwd packages/backend add @iswesolutions/plugin-ipam-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@iswesolutions/plugin-ipam-backend'));
// optional: index IP addresses in Backstage search
backend.add(import('@iswesolutions/plugin-ipam-backend/search'));
```

## phpIPAM

Create an API app in phpIPAM (_Administration → API_) with app security
"SSL with App code token", and give it read/write access.

## Configuration

```yaml
ipam:
  phpipam:
    url: https://phpipam.example.com/api/backstage
    appCode: ${PHPIPAM_APP_CODE}
    verifyTls: true
  # Optional: hand out static addresses for new hosts
  allocation:
    subnet: 10.0.0.0
    prefix: 24
    from: 10.0.0.100
    to: 10.0.0.199
    gateway: 10.0.0.1
    nameserver: 10.0.0.53
  # Optional: DHCP pools, shaded on the subnet map
  dhcpRanges:
    - from: 10.0.0.200
      to: 10.0.0.254
  # Optional: Proxmox node -> web UI URL, for links to guests
  proxmoxUiUrls:
    pve1: https://pve1.example.com:8006
  # Optional: notifications for new issues
  notifications:
    enabled: true
    recipients: [group:default/network-admins]
    thresholds: [80, 90]
```

See [`config.d.ts`](config.d.ts) for every option.

## Permissions

Reads are open to signed-in users. Writes check these permissions, defined in
`@iswesolutions/plugin-ipam-common`:

`ipam.address.create`, `ipam.address.update`, `ipam.address.delete`,
`ipam.subnet.create`, `ipam.subnet.update`, `ipam.vlan.create`
