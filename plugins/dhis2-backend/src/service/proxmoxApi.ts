import { LoggerService } from '@backstage/backend-plugin-api';
import { Agent as HttpsAgent } from 'https';
// Node 18+ exposes `fetch` globally; we keep an `any`-typed alias so this
// file compiles without depending on a DOM lib type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFetch: any = (globalThis as any).fetch;

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

const insecureAgent = new HttpsAgent({ rejectUnauthorized: false });

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
  try {
    const res = await nodeFetch(url, {
      method,
      headers,
      body: payload,
      signal: ctrl.signal,
      // For self-signed PVE certs (default), disable TLS verification.
      // Otherwise leave the default agent so the system CAs apply.
      agent: c.validateCerts ? undefined : insecureAgent,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Proxmox ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
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
      `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/config`,
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
    `/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(String(vmid))}/config`,
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
