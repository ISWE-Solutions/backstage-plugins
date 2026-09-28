import { ProxmoxCluster } from '@internal/plugin-proxmox-common';
import { ClusterInput, ClusterStore, DbCluster } from './clusterStore';
import { createProxmoxClient, ProxmoxClient } from './proxmoxClient';

/** A cluster defined in app-config (read-only, token stays in config). */
export interface ConfigCluster {
  id: string;
  name: string;
  url: string;
  token: string;
  verifyTls: boolean;
  uiUrls: Record<string, string>;
}

export interface ResolvedCluster {
  id: string;
  name: string;
  url: string;
  token: string;
  verifyTls: boolean;
  uiUrls: Record<string, string>;
  source: 'config' | 'db';
}

export interface ClusterRegistry {
  /** Public metadata for every cluster (never includes tokens). */
  list(): Promise<ProxmoxCluster[]>;
  /** Resolve a cluster with its token, for building a client. */
  resolve(id: string): Promise<ResolvedCluster | undefined>;
  /** A ready Proxmox client for a cluster, or undefined if unknown. */
  clientFor(
    id: string,
  ): Promise<{ client: ProxmoxClient; cluster: ResolvedCluster } | undefined>;
  /** Default cluster id: first config cluster, else first db cluster. */
  defaultId(): Promise<string | undefined>;
  add(input: ClusterInput): Promise<ProxmoxCluster>;
  update(id: string, patch: ClusterInput): Promise<ProxmoxCluster | undefined>;
  remove(id: string): Promise<boolean>;
}

const toPublic = (
  c: {
    id: string;
    name: string;
    url: string;
    verifyTls: boolean;
    uiUrls: Record<string, string>;
  },
  source: 'config' | 'db',
  hasToken: boolean,
): ProxmoxCluster => ({
  id: c.id,
  name: c.name,
  url: c.url,
  verifyTls: c.verifyTls,
  source,
  hasToken,
  uiUrls: c.uiUrls,
});

const dbToResolved = (c: DbCluster): ResolvedCluster => ({
  ...c,
  source: 'db',
});

/**
 * Combines app-config clusters (read-only baseline) with UI-added clusters from
 * the database into one registry. Config clusters are never editable through the
 * API; only DB clusters can be added/updated/removed. A short-lived client cache
 * avoids rebuilding an https agent on every cache-missing request.
 */
export function createClusterRegistry(deps: {
  configClusters: ConfigCluster[];
  store?: ClusterStore;
}): ClusterRegistry {
  const { configClusters, store } = deps;
  const clients = new Map<string, { client: ProxmoxClient; key: string }>();

  const resolveConfig = (id: string) => configClusters.find(c => c.id === id);

  const requireDbStore = (): ClusterStore => {
    if (!store) throw new Error('cluster database is not available');
    return store;
  };

  const registry: ClusterRegistry = {
    async list() {
      const cfg = configClusters.map(c => toPublic(c, 'config', true));
      const db = store
        ? (await store.list()).map(c => toPublic(c, 'db', Boolean(c.token)))
        : [];
      return [...cfg, ...db];
    },

    async resolve(id) {
      const cfg = resolveConfig(id);
      if (cfg) return { ...cfg, source: 'config' };
      if (store) {
        const db = await store.get(id);
        if (db) return dbToResolved(db);
      }
      return undefined;
    },

    async clientFor(id) {
      const cluster = await registry.resolve(id);
      if (!cluster || !cluster.token) return undefined;
      const key = `${cluster.url}|${cluster.verifyTls}|${cluster.token}`;
      const cached = clients.get(id);
      let client: ProxmoxClient;
      if (cached && cached.key === key) {
        client = cached.client;
      } else {
        client = createProxmoxClient({
          url: cluster.url,
          token: cluster.token,
          verifyTls: cluster.verifyTls,
        });
        clients.set(id, { client, key });
      }
      return { client, cluster };
    },

    async defaultId() {
      if (configClusters.length) return configClusters[0].id;
      if (store) {
        const db = await store.list();
        if (db.length) return db[0].id;
      }
      return undefined;
    },

    async add(input) {
      const c = await requireDbStore().add(input);
      return toPublic(c, 'db', Boolean(c.token));
    },

    async update(id, patch) {
      if (resolveConfig(id)) {
        throw Object.assign(
          new Error('config-defined clusters cannot be edited via the API'),
          { statusCode: 400 },
        );
      }
      const c = await requireDbStore().update(id, patch);
      clients.delete(id);
      return c ? toPublic(c, 'db', Boolean(c.token)) : undefined;
    },

    async remove(id) {
      if (resolveConfig(id)) {
        throw Object.assign(
          new Error('config-defined clusters cannot be removed via the API'),
          { statusCode: 400 },
        );
      }
      clients.delete(id);
      return requireDbStore().remove(id);
    },
  };

  return registry;
}
