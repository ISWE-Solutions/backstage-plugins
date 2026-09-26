import { IPAddress } from '../../types';

/**
 * The sync describes Proxmox guests as "LXC 115 on pve11" / "VM 223 on pve13"
 * (optionally "(stopped)"). Returns the Proxmox web UI link for that guest.
 */
export function proxmoxGuestLink(
  address: Pick<IPAddress, 'description'>,
  uiUrls: Record<string, string>,
): string | undefined {
  const m = /\b(LXC|VM) (\d+) on (\S+)/.exec(address.description ?? '');
  if (!m) return undefined;
  const base = uiUrls[m[3]];
  if (!base) return undefined;
  const kind = m[1] === 'LXC' ? 'lxc' : 'qemu';
  return `${base.replace(/\/$/, '')}/#v1:0:=${kind}%2F${m[2]}:4:::::::`;
}

/** Backstage search for the host, to find its catalog entity or docs */
export function backstageSearchLink(
  address: Pick<IPAddress, 'hostname' | 'ipAddress'>,
) {
  const term = address.hostname || address.ipAddress;
  return `/search?query=${encodeURIComponent(term)}`;
}
