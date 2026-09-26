import { IPAddress, IPStatus } from './types';

/** A raw phpIPAM API object */
export type Raw = Record<string, any>;

// phpIPAM address tags (ipTags table)
export const TAG_TO_STATUS: Record<string, IPStatus> = {
  '1': IPStatus.OFFLINE,
  '2': IPStatus.ALLOCATED,
  '3': IPStatus.RESERVED,
  '4': IPStatus.DHCP,
};
export const STATUS_TO_TAG: Record<IPStatus, number> = {
  [IPStatus.OFFLINE]: 1,
  [IPStatus.ALLOCATED]: 2,
  [IPStatus.RESERVED]: 3,
  [IPStatus.DHCP]: 4,
};

export const DISCOVERY_MARKER = 'discovery:';
// note phpIPAM's own discoveryCheck.php puts on hosts found by its ping sweep
export const SCAN_NOTE = 'This host was autodiscovered';

export interface PhpIpamResponse<T> {
  code: number;
  success: boolean | number;
  data?: T;
  message?: string;
}

export const toIso = (value?: string | null) =>
  value && !value.startsWith('0000')
    ? new Date(value.replace(' ', 'T')).toISOString()
    : undefined;

/** "discovery: proxmox+arp; LXC 115 on pve11; last seen ..." -> "proxmox+arp" */
export const sourceFromNote = (note?: string | null) => {
  const lines = (note ?? '').split('\n');
  const line = lines.find(l => l.startsWith(DISCOVERY_MARKER));
  if (line) return line.slice(DISCOVERY_MARKER.length).split(';')[0].trim();
  return lines.some(l => l.startsWith(SCAN_NOTE)) ? 'scan' : 'manual';
};

/** Map a phpIPAM address to the IPAM model */
export function toAddress(
  raw: Raw,
  vlanBySubnet: Map<string, string | undefined> = new Map(),
): IPAddress {
  return {
    id: String(raw.id),
    ipAddress: raw.ip,
    subnetId: String(raw.subnetId),
    hostname: raw.hostname ?? undefined,
    description: raw.description ?? undefined,
    status: TAG_TO_STATUS[String(raw.tag)] ?? IPStatus.ALLOCATED,
    assignedTo: raw.owner ?? undefined,
    macAddress: raw.mac ?? undefined,
    source: sourceFromNote(raw.note),
    vlanId: vlanBySubnet.get(String(raw.subnetId)),
    lastSeen: toIso(raw.lastSeen),
    notes: raw.note ?? undefined,
    createdAt: toIso(raw.editDate) ?? new Date(0).toISOString(),
    updatedAt: toIso(raw.editDate) ?? new Date(0).toISOString(),
  };
}
