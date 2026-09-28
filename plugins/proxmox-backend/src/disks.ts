import {
  ProxmoxDisk,
  ProxmoxDiskSmart,
  SmartAttribute,
} from '@internal/plugin-proxmox-common';
import { ProxmoxClient } from './proxmoxClient';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const optNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '' || v === 'N/A')
    return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Aggregate physical disks across the given nodes (/nodes/{node}/disks/list). */
export async function fetchDisks(
  client: ProxmoxClient,
  nodes: string[],
): Promise<ProxmoxDisk[]> {
  const out: ProxmoxDisk[] = [];
  await Promise.all(
    nodes.map(async node => {
      try {
        const r = await client.get(`nodes/${node}/disks/list`);
        if (r.status < 200 || r.status >= 300) return;
        const list = ((r.body as any)?.data ?? []) as any[];
        for (const d of list) {
          const devpath = String(d.devpath ?? '');
          const osdid = optNum(d.osdid);
          out.push({
            id: `${node}:${devpath}`,
            node,
            devpath,
            model: d.model ? String(d.model).trim() : undefined,
            serial: d.serial ? String(d.serial).trim() : undefined,
            vendor: d.vendor ? String(d.vendor).trim() : undefined,
            size: num(d.size),
            type: String(d.type ?? 'unknown').toLowerCase(),
            health: d.health ? String(d.health) : undefined,
            wearout: optNum(d.wearout),
            used:
              d.used && String(d.used) !== ''
                ? String(d.used)
                : osdid !== undefined && osdid >= 0
                ? `Ceph OSD.${osdid}`
                : undefined,
            rpm: optNum(d.rpm),
          });
        }
      } catch {
        // node may be down or not support disks/list; skip it
      }
    }),
  );
  out.sort(
    (a, b) =>
      a.node.localeCompare(b.node) || a.devpath.localeCompare(b.devpath),
  );
  return out;
}

const firstRaw = (attrs: SmartAttribute[], re: RegExp): number | undefined => {
  const a = attrs.find(x => re.test(x.name));
  if (!a) return undefined;
  const m = String(a.raw ?? '').match(/-?\d+/);
  return m ? Number(m[0]) : a.value;
};

/** SMART detail for one disk (/nodes/{node}/disks/smart?disk=…). */
export async function fetchSmart(
  client: ProxmoxClient,
  node: string,
  disk: string,
): Promise<ProxmoxDiskSmart> {
  const r = await client.get(
    `nodes/${encodeURIComponent(node)}/disks/smart?disk=${encodeURIComponent(
      disk,
    )}`,
  );
  const data = (r.body as any)?.data ?? {};
  const attributes: SmartAttribute[] = Array.isArray(data.attributes)
    ? data.attributes.map((a: any) => ({
        id: optNum(a.id),
        name: String(a.name ?? a.id ?? ''),
        value: optNum(a.value),
        worst: optNum(a.worst),
        threshold: optNum(a.threshold),
        raw: a.raw !== undefined ? String(a.raw) : undefined,
      }))
    : [];
  return {
    health: data.health ? String(data.health) : undefined,
    type: data.type ? String(data.type) : undefined,
    attributes,
    temperature: firstRaw(attributes, /temperature|airflow_temp/i),
    powerOnHours: firstRaw(attributes, /power[_ ]?on[_ ]?hours/i),
    text: data.text ? String(data.text) : undefined,
  };
}
