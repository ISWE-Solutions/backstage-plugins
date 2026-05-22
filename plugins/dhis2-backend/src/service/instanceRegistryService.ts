import { LoggerService } from '@backstage/backend-plugin-api';
import { PersistedInstance, ProvisionService } from './provisionService';
import {
  DHIS2_PRIMARY_TAG,
  ProxmoxClusterResource,
  listClusterResources,
  parseTags,
} from './proxmoxApi';

/**
 * Reconciles the dhis2-backend's authoritative registry of provisioned
 * instances against live state on the Proxmox cluster. The Instances page
 * uses the enriched listing to decide which containers to surface and to
 * flag drift to the operator.
 *
 *   - "managed"   : the registry knows about a container that exists on
 *                   Proxmox AND carries the `dhis2` tag. Healthy case.
 *   - "untagged"  : registered container exists but is missing the
 *                   `dhis2` tag (someone cleared it in the PVE UI).
 *   - "missing"   : registered container no longer exists at the
 *                   recorded (node, vmid) \u2014 it was deleted out-of-band.
 *   - "unknown"   : Proxmox API is not configured / unreachable, so drift
 *                   cannot be determined. We still return the registry
 *                   entry; the UI shows the chip as informational.
 */
export type DriftStatus = 'managed' | 'untagged' | 'missing' | 'unknown';

export interface EnrichedInstance extends PersistedInstance {
  driftStatus: DriftStatus;
  /** Live status from Proxmox when available, else the stored value. */
  liveStatus?: 'running' | 'stopped' | 'provisioning' | 'error';
}

export interface ReconciliationReport {
  /**
   * Containers in the cluster that carry the `dhis2` tag but are NOT in
   * the registry \u2014 candidates to "adopt" or evidence that something was
   * created outside this plugin.
   */
  unmanaged: ProxmoxClusterResource[];
  /**
   * Registered instances whose underlying container no longer exists on
   * Proxmox \u2014 candidates to retire from the registry.
   */
  orphans: PersistedInstance[];
  /**
   * Registered instances that exist on Proxmox but no longer carry the
   * `dhis2` tag \u2014 typically a manual edit in the PVE UI.
   */
  untagged: PersistedInstance[];
  /** True when we could actually reach Proxmox; false when API is down. */
  proxmoxReachable: boolean;
  /** Human-readable reason when `proxmoxReachable` is false. */
  unreachableReason?: string;
}

function normaliseStatus(
  s: string | undefined,
): 'running' | 'stopped' | 'provisioning' | 'error' | undefined {
  if (!s) return undefined;
  if (s === 'running' || s === 'stopped') return s;
  // PVE returns 'unknown' for transient states \u2014 surface as 'error' so
  // the UI shows something meaningful.
  return 'error';
}

export class InstanceRegistryService {
  constructor(
    private readonly logger: LoggerService,
    private readonly provisionService: ProvisionService,
  ) {}

  /**
   * List registered instances, enriched with live drift status from
   * Proxmox when API credentials are configured.
   */
  async listEnriched(): Promise<EnrichedInstance[]> {
    const registered = await this.provisionService.listInstances();
    const creds = this.provisionService.proxmoxCredentials();
    if (!creds || registered.length === 0) {
      return registered.map(r => ({ ...r, driftStatus: 'unknown' as const }));
    }
    let resources: ProxmoxClusterResource[] = [];
    try {
      resources = await listClusterResources(creds);
    } catch (err) {
      this.logger.warn(
        `DHIS2: reconcile listClusterResources failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return registered.map(r => ({ ...r, driftStatus: 'unknown' as const }));
    }
    const byKey = new Map<string, ProxmoxClusterResource>();
    for (const r of resources) {
      if (r.type !== 'lxc') continue;
      byKey.set(`${r.node}/${r.vmid}`, r);
    }
    return registered.map(inst => {
      const r = byKey.get(`${inst.node}/${inst.vmid}`);
      if (!r) {
        return { ...inst, driftStatus: 'missing' as const };
      }
      const tags = parseTags(r.tags);
      const driftStatus: DriftStatus = tags.includes(DHIS2_PRIMARY_TAG)
        ? 'managed'
        : 'untagged';
      return {
        ...inst,
        driftStatus,
        liveStatus: normaliseStatus(r.status) ?? inst.status,
      };
    });
  }

  /**
   * Build a reconciliation report comparing registered instances against
   * the live cluster. Used by the UI to surface drift to the operator.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const registered = await this.provisionService.listInstances();
    const creds = this.provisionService.proxmoxCredentials();
    if (!creds) {
      return {
        unmanaged: [],
        orphans: [],
        untagged: [],
        proxmoxReachable: false,
        unreachableReason:
          'Proxmox API credentials are not configured \u2014 set dhis2.orchestrator.{apiUrl,apiUser,apiTokenId,apiTokenSecret}.',
      };
    }
    let resources: ProxmoxClusterResource[];
    try {
      resources = await listClusterResources(creds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`DHIS2: reconcile cluster query failed: ${message}`);
      return {
        unmanaged: [],
        orphans: [],
        untagged: [],
        proxmoxReachable: false,
        unreachableReason: message,
      };
    }
    const registeredKey = new Set(
      registered.map(i => `${i.node}/${i.vmid}`),
    );
    const lxcs = resources.filter(r => r.type === 'lxc');
    const unmanaged: ProxmoxClusterResource[] = [];
    for (const r of lxcs) {
      const tags = parseTags(r.tags);
      if (!tags.includes(DHIS2_PRIMARY_TAG)) continue;
      if (registeredKey.has(`${r.node}/${r.vmid}`)) continue;
      unmanaged.push(r);
    }
    const liveKey = new Set(lxcs.map(r => `${r.node}/${r.vmid}`));
    const orphans: PersistedInstance[] = [];
    const untagged: PersistedInstance[] = [];
    for (const inst of registered) {
      const key = `${inst.node}/${inst.vmid}`;
      if (!liveKey.has(key)) {
        orphans.push(inst);
        continue;
      }
      const r = lxcs.find(x => `${x.node}/${x.vmid}` === key);
      const tags = parseTags(r?.tags);
      if (!tags.includes(DHIS2_PRIMARY_TAG)) untagged.push(inst);
    }
    return {
      unmanaged,
      orphans,
      untagged,
      proxmoxReachable: true,
    };
  }
}
