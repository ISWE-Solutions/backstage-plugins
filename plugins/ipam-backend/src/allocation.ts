import { execFile } from 'node:child_process';
import { LoggerService } from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import { PhpIpamClient } from './phpipamClient';

export interface AllocationConfig {
  /** Network address of the phpIPAM subnet to allocate from, e.g. 10.20.30.0 */
  subnet: string;
  prefix: number;
  /** First and last address that may be handed out (inclusive) */
  from: string;
  to: string;
  gateway: string;
}

export interface Allocation {
  id: string;
  ip: string;
  prefix: number;
  gateway: string;
}

/** Marks records created by allocation; confirm/release only touch these */
export const ALLOCATION_MARKER = 'allocated:';
const TAG_USED = 2;
const TAG_RESERVED = 3;

const toInt = (ip: string) =>
  ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
const toIp = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

/** True when something answers one ICMP echo within a second */
export const pingAnswers = (ip: string): Promise<boolean> =>
  new Promise(resolve => {
    execFile('ping', ['-c', '1', '-W', '1', ip], error => resolve(!error));
  });

const ok = (status: number) => status >= 200 && status < 300;

/**
 * Hands out static addresses from a pool inside one phpIPAM subnet.
 *
 * An address is reserved (phpIPAM tag "Reserved", note "allocated: …") before
 * it is returned, so two callers can never receive the same address; the
 * caller then confirms it (tag "Used") once the container exists, or releases
 * it if creation failed. Allocations are serialised within this process, and
 * phpIPAM itself refuses a second record for the same IP.
 */
export class AllocationService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly phpipam: PhpIpamClient,
    private readonly cfg: AllocationConfig,
    private readonly logger: LoggerService,
    private readonly inUse: (ip: string) => Promise<boolean> = pingAnswers,
  ) {}

  get pool() {
    return { ...this.cfg };
  }

  allocate(request: {
    hostname: string;
    purpose: string;
    requestedBy: string;
  }): Promise<Allocation> {
    const run = this.queue.then(() => this.allocateNow(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async subnetId(): Promise<string> {
    const r = await this.phpipam.request(
      'GET',
      `subnets/cidr/${this.cfg.subnet}/${this.cfg.prefix}/`,
    );
    const data = (r.body as any)?.data;
    if (!ok(r.status) || !Array.isArray(data) || !data[0]?.id) {
      throw new NotFoundError(
        `phpIPAM has no subnet ${this.cfg.subnet}/${this.cfg.prefix}`,
      );
    }
    return String(data[0].id);
  }

  private async allocateNow(request: {
    hostname: string;
    purpose: string;
    requestedBy: string;
  }): Promise<Allocation> {
    const subnetId = await this.subnetId();
    const listed = await this.phpipam.request(
      'GET',
      `subnets/${subnetId}/addresses/`,
    );
    const recorded = new Set<string>(
      ((listed.body as any)?.data ?? []).map((a: any) => String(a.ip)),
    );

    const first = toInt(this.cfg.from);
    const last = toInt(this.cfg.to);
    let busy = 0;
    for (let n = first; n <= last; n++) {
      const ip = toIp(n);
      if (recorded.has(ip)) continue;
      if (await this.inUse(ip)) {
        // unrecorded but live: leave it for the discovery scan to record
        busy++;
        this.logger.warn(
          `ipam: ${ip} is unrecorded but answers ping; skipping`,
        );
        continue;
      }
      const now = new Date().toISOString();
      const created = await this.phpipam.request('POST', 'addresses/', {
        subnetId,
        ip,
        hostname: request.hostname,
        description: `Reserved: ${request.purpose}`,
        owner: request.requestedBy,
        tag: TAG_RESERVED,
        note: `${ALLOCATION_MARKER} ${request.requestedBy} for ${request.purpose} on ${now}`,
      });
      if (!ok(created.status)) {
        // most likely created by someone else since we listed; try the next
        this.logger.warn(
          `ipam: phpIPAM refused ${ip} (${created.status}); trying next address`,
        );
        continue;
      }
      const id = String(
        (created.body as any)?.id ?? (created.body as any)?.data?.id ?? '',
      );
      this.logger.info(
        `ipam: allocated ${ip} (address ${id}) to ${request.hostname} for ${request.requestedBy}`,
      );
      return { id, ip, prefix: this.cfg.prefix, gateway: this.cfg.gateway };
    }
    const busyNote = busy ? ` (${busy} unrecorded addresses answer ping)` : '';
    throw new ConflictError(
      `No free address in ${this.cfg.from}–${this.cfg.to}${busyNote}. Free some addresses or widen ipam.allocation.`,
    );
  }

  private async allocationRecord(id: string) {
    const r = await this.phpipam.request('GET', `addresses/${id}/`);
    const record = (r.body as any)?.data;
    if (!ok(r.status) || !record) {
      throw new NotFoundError(`phpIPAM address ${id} not found`);
    }
    if (!String(record.note ?? '').includes(ALLOCATION_MARKER)) {
      throw new ConflictError(
        `phpIPAM address ${id} was not created by allocation; refusing to change it`,
      );
    }
    return record;
  }

  /** Mark an allocation as in use once the container exists */
  async confirm(
    id: string,
    details: { hostname?: string; description?: string },
  ): Promise<void> {
    const record = await this.allocationRecord(id);
    const r = await this.phpipam.request('PATCH', `addresses/${id}/`, {
      tag: TAG_USED,
      ...(details.hostname ? { hostname: details.hostname } : {}),
      ...(details.description ? { description: details.description } : {}),
      note: `${record.note}\nconfirmed ${new Date().toISOString()}`,
    });
    if (!ok(r.status)) {
      throw new Error(`phpIPAM refused to confirm address ${id} (${r.status})`);
    }
  }

  /** Give back an allocation that was never used (still Reserved) */
  async release(id: string): Promise<void> {
    const record = await this.allocationRecord(id);
    if (String(record.tag) !== String(TAG_RESERVED)) {
      throw new ConflictError(
        `phpIPAM address ${id} is already in use; release it in phpIPAM if the container is gone`,
      );
    }
    const r = await this.phpipam.request('DELETE', `addresses/${id}/`);
    if (!ok(r.status)) {
      throw new Error(`phpIPAM refused to release address ${id} (${r.status})`);
    }
    this.logger.info(`ipam: released allocation ${id} (${record.ip})`);
  }
}
