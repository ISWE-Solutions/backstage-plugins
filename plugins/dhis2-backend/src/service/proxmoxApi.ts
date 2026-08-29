import { LoggerService } from '@backstage/backend-plugin-api';
// Node 18+ exposes `fetch` globally; we keep an `any`-typed alias so this
// file compiles without depending on a DOM lib type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFetch: any = (globalThis as any).fetch;
// Node's global fetch is backed by undici, which ignores the legacy
// `agent` option used by node-fetch. To disable TLS verification (for
// the typical self-signed Proxmox cert) we have to pass an undici
// `Agent` as `dispatcher`. Loaded lazily so the file still type-checks
// in environments where undici is unavailable.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { Agent: UndiciAgent } = require('undici') as {
  Agent: new (opts: { connect?: { rejectUnauthorized?: boolean } }) => unknown;
};

/**
 * Minimal Proxmox REST API client used by the dhis2-backend plugin to
 * (a) tag freshly provisioned LXCs as `dhis2;backstage`, (b) verify that
 * persisted instances still exist and remain tagged, and (c) enumerate
 * containers in the cluster carrying the `dhis2` tag for reconciliation.
 *
 * Auth uses Proxmox API tokens (`PVEAPIToken=user@realm!tokenid=secret`).
 * All requests are best-effort — callers must handle network/API failures
 * gracefully so the plugin never breaks when Proxmox is unreachable.
 */
export interface ProxmoxApiCredentials {
  apiUrl: string;
  apiUser: string; // e.g. "root@pam"
  apiTokenId: string; // token name AFTER the `!`
  apiTokenSecret: string;
  validateCerts?: boolean;
}

/** Subset of `/cluster/resources?type=vm` we care about. */
export interface ProxmoxClusterResource {
  vmid: number;
  node: string;
  type: string; // 'lxc' | 'qemu'
  name?: string;
  status?: string; // 'running' | 'stopped' | ...
  tags?: string; // semicolon-separated
  uptime?: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** Semicolon-separated tag string applied to every LXC the plugin creates. */
export const DHIS2_TAGS = 'dhis2;backstage';
/** The single tag we treat as the "managed by this plugin" marker. */
export const DHIS2_PRIMARY_TAG = 'dhis2';

const insecureDispatcher = new UndiciAgent({
  connect: { rejectUnauthorized: false },
});

function authHeader(c: ProxmoxApiCredentials): string {
  return `PVEAPIToken=${c.apiUser}!${c.apiTokenId}=${c.apiTokenSecret}`;
}

function normaliseUrl(apiUrl: string): string {
  let u = apiUrl.trim().replace(/\/+$/, '');
  if (!/\/api2\/json$/.test(u)) {
    u = `${u}/api2/json`;
  }
  return u;
}

async function request<T>(
  c: ProxmoxApiCredentials,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  if (!nodeFetch) {
    throw new Error(
      'Node global fetch is unavailable. The dhis2 backend plugin requires Node 18 or newer.',
    );
  }
  const url = `${normaliseUrl(c.apiUrl)}${path}`;
  const headers: Record<string, string> = {
    Authorization: authHeader(c),
  };
  let payload: string | URLSearchParams | undefined;
  if (body) {
    // Proxmox accepts form-encoded params for write operations.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    payload = params;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: any;
  try {
    res = await nodeFetch(url, {
      method,
      headers,
      body: payload,
      signal: ctrl.signal,
      // Node's global fetch (undici) ignores the legacy `agent` option;
      // use `dispatcher` with an undici Agent so the rejectUnauthorized
      // flag is actually honored when talking to a self-signed PVE cert.
      dispatcher: c.validateCerts ? undefined : insecureDispatcher,
    });
  } catch (err) {
    // Node's global fetch (undici) wraps the underlying transport error
    // in a generic `TypeError: fetch failed` and stashes the real cause
    // (ENOTFOUND, ECONNREFUSED, self-signed cert, etc.) on `.cause`.
    // Surface that so callers/operators see something actionable.
    clearTimeout(timer);
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error
        ? cause.message
        : cause
        ? String(cause)
        : undefined;
    const codeSuffix =
      cause &&
      typeof (cause as { code?: unknown }).code === 'string' &&
      causeMsg &&
      !causeMsg.includes((cause as { code: string }).code)
        ? ` [${(cause as { code: string }).code}]`
        : '';
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Proxmox ${method} ${path} (${url}) failed: ${base}${
        causeMsg ? ` — ${causeMsg}${codeSuffix}` : ''
      }`,
    );
  }
  try {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Proxmox ${method} ${path} failed (HTTP ${res.status}): ${text.slice(
          0,
          200,
        )}`,
      );
    }
    const json = (await res.json()) as { data?: T };
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** List every VM/LXC in the cluster (single API call, cluster-scoped). */
export async function listClusterResources(
  c: ProxmoxApiCredentials,
): Promise<ProxmoxClusterResource[]> {
  return (
    (await request<ProxmoxClusterResource[]>(
      c,
      'GET',
      '/cluster/resources?type=vm',
    )) ?? []
  );
}

/** Ask Proxmox for the next available VMID (`/cluster/nextid`). */
export async function getNextClusterVmid(
  c: ProxmoxApiCredentials,
): Promise<number> {
  const raw = await request<number | string>(c, 'GET', '/cluster/nextid');
  const vmid = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    throw new Error(`Proxmox returned invalid next VMID: ${String(raw)}`);
  }
  return vmid;
}

/** Read the configuration of a single LXC (used to read current tags). */
export async function getLxcConfig(
  c: ProxmoxApiCredentials,
  node: string,
  vmid: number | string,
): Promise<Record<string, unknown>> {
  return (
    (await request<Record<string, unknown>>(
      c,
      'GET',
      `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(
        String(vmid),
      )}/config`,
    )) ?? {}
  );
}

/**
 * Set the semicolon-separated tag list on an LXC. Existing tags are
 * preserved by merging with `additionalTags` (de-duplicated, case-insensitive).
 */
export async function ensureLxcTags(
  c: ProxmoxApiCredentials,
  node: string,
  vmid: number | string,
  additionalTags: string[],
  logger?: LoggerService,
): Promise<string> {
  let existing = '';
  try {
    const cfg = await getLxcConfig(c, node, vmid);
    if (typeof cfg.tags === 'string') existing = cfg.tags;
  } catch (err) {
    logger?.warn(
      `DHIS2: failed to read existing tags for ${node}/lxc/${vmid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const merged = mergeTags(existing, additionalTags);
  if (normalisedTagSet(existing).join(';') === merged) {
    // Already up to date — skip the write to keep the API quiet.
    return merged;
  }
  await request(
    c,
    'PUT',
    `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(
      String(vmid),
    )}/config`,
    { tags: merged },
  );
  return merged;
}

/** Parse a Proxmox tag string into a normalised lower-case array. */
export function parseTags(tags: string | undefined | null): string[] {
  if (!tags) return [];
  return tags
    .split(/[;,]/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function normalisedTagSet(existing: string): string[] {
  return Array.from(new Set(parseTags(existing))).sort();
}

function mergeTags(existing: string, additional: string[]): string {
  const set = new Set(parseTags(existing));
  for (const t of additional) {
    const v = t.trim().toLowerCase();
    if (v) set.add(v);
  }
  return Array.from(set).sort().join(';');
}

/**
 * Return the first non-loopback IPv4 address reported for an LXC's
 * network interfaces. Used by features (log tail, ad-hoc shell) that
 * need to reach the container directly instead of via `pct exec`.
 */
export async function getLxcIpv4(
  c: ProxmoxApiCredentials,
  node: string,
  vmid: number | string,
): Promise<string | undefined> {
  const data = await request<
    Array<{ name?: string; inet?: string; hwaddr?: string }>
  >(
    c,
    'GET',
    `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(
      String(vmid),
    )}/interfaces`,
  );
  if (!Array.isArray(data)) return undefined;
  for (const iface of data) {
    if (!iface || iface.name === 'lo' || !iface.inet) continue;
    const ip = String(iface.inet).split('/')[0].trim();
    if (ip && !ip.startsWith('127.')) return ip;
  }
  return undefined;
}
