import { DHIS2Instance, RestoreJob, RestoreSource, DumpFormat } from '../types';
import { dhis2Service } from './dhis2Service';

/**
 * Hard cap on browser-side uploads. Larger payloads should be routed
 * through URL / S3 / vzdump sources instead so the dump is fetched
 * directly by the backend without traversing the browser.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3; // 2 GiB

/** Result of a successful dump upload. */
export interface UploadResult {
  uploadToken: string;
  sizeBytes: number;
  expiresAt: string;
}

/** Progress callback signature for uploads. */
export type UploadProgress = (loaded: number, total: number) => void;

/** Lightweight listing of a vzdump archive on a Proxmox storage. */
export interface VzdumpBackup {
  volid: string;
  /** Original VMID the backup was taken from */
  vmid?: number;
  size?: number;
  ctime?: number;
  notes?: string;
}

/**
 * Detect the dump format from a filename extension. Falls back to
 * `'custom'` (the most common `pg_dump -Fc` output) when the extension
 * is ambiguous; the UI exposes an override so the user can correct it.
 */
export function detectDumpFormat(filename: string): DumpFormat {
  const lower = filename.toLowerCase();
  if (
    lower.endsWith('.sql') ||
    lower.endsWith('.sql.gz') ||
    lower.endsWith('.sql.zst') ||
    lower.endsWith('.sql.bz2')
  ) {
    return 'plain';
  }
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz')) {
    return 'directory';
  }
  // .dump / .backup / .pgdump and unknown → assume custom (-Fc)
  return 'custom';
}

/**
 * Client-side validation for a `RestoreSource` before submitting the
 * create / restore request. Returns `null` when the source is valid, or
 * a human-readable error string otherwise.
 */
export function validateRestoreSource(
  source: RestoreSource | undefined,
): string | null {
  if (!source) return null;
  switch (source.kind) {
    case 'upload':
      if (!source.uploadToken) return 'Upload has not completed yet.';
      if (source.sizeBytes <= 0) return 'Uploaded file is empty.';
      return null;
    case 'url':
      if (!source.url) return 'URL is required.';
      try {
        const u = new URL(source.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return 'URL must use http:// or https://';
        }
      } catch {
        return 'URL is not valid.';
      }
      return null;
    case 's3':
      if (!source.bucket) return 'S3 bucket is required.';
      if (!source.key) return 'S3 key is required.';
      if (!source.useSettingsCredentials) {
        if (!source.accessKeyId || !source.secretAccessKey) {
          return 'S3 credentials are required (or enable "use settings credentials").';
        }
      }
      return null;
    case 'instance':
      if (!source.sourceInstanceId)
        return 'Pick a source instance to clone from.';
      return null;
    case 'vzdump':
      if (!source.node) return 'Proxmox node is required.';
      if (!source.storage) return 'Backup storage is required.';
      if (!source.volid) return 'Pick a backup archive (volid).';
      return null;
    case 'local':
      if (!source.node) return 'Proxmox node is required.';
      if (!source.path || !source.path.startsWith('/')) {
        return 'Absolute path on the host is required.';
      }
      return null;
    default:
      return 'Unknown restore source.';
  }
}

/**
 * Frontend service that wraps the (yet-to-be-built) restore API.
 *
 * Until a backend plugin exists, the methods mock their responses so the
 * UI can be developed in isolation — same pattern as `ansibleService.ts`.
 */
export class RestoreService {
  constructor(
    private readonly baseUrl: string = '/api/dhis2',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /**
   * Upload a dump file to the backend staging area. Returns an opaque
   * token that is then included in a `RestoreSource` of kind `upload`.
   *
   * Backend contract:
   *   POST {baseUrl}/restore/upload
   *     Content-Type: application/octet-stream
   *     X-Filename:   <original filename>
   *     body:         raw bytes of the dump file
   *   200 : UploadResult
   *
   * Uses `XMLHttpRequest` rather than `fetch` so we can surface real
   * upload progress to the UI. Streams the raw file bytes rather than
   * wrapping them in multipart/form-data so the backend can stage to
   * disk without pulling in a multipart parser dependency.
   */
  async uploadDump(
    file: File,
    onProgress?: UploadProgress,
  ): Promise<UploadResult> {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `File is ${(file.size / 1024 ** 3).toFixed(2)} GiB which exceeds the ${
          MAX_UPLOAD_BYTES / 1024 ** 3
        } GiB upload limit. Use URL, S3 or vzdump source instead.`,
      );
    }

    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${this.baseUrl}/restore/upload`;
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', file.name);

      xhr.upload.onprogress = ev => {
        if (onProgress && ev.lengthComputable) {
          onProgress(ev.loaded, ev.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as UploadResult;
            resolve(body);
          } catch (e) {
            reject(
              new Error(
                `Upload succeeded but response was not JSON: ${
                  (e as Error).message
                }`,
              ),
            );
          }
          return;
        }
        let detail = `${xhr.status} ${xhr.statusText}`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed && typeof parsed.error === 'string') detail = parsed.error;
        } catch {
          /* response body wasn't JSON; keep the status line */
        }
        reject(new Error(`Upload failed: ${detail}`));
      };

      xhr.onerror = () => {
        reject(new Error(`Network error while uploading to ${url}`));
      };

      xhr.send(file);
    });
  }

  /**
   * List vzdump archives available on a given Proxmox storage. The UI
   * uses this to populate the volid `Select` when the user picks a
   * Proxmox-backup restore source.
   *
   * Backend contract:
   *   GET {baseUrl}/proxmox/{node}/storage/{storage}/backups → VzdumpBackup[]
   */
  async listVzdumpBackups(
    node: string,
    storage: string,
  ): Promise<VzdumpBackup[]> {
    const url = `${this.baseUrl}/proxmox/${encodeURIComponent(
      node,
    )}/storage/${encodeURIComponent(storage)}/backups`;
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(
        `Failed to list vzdump backups: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { data?: VzdumpBackup[] };
    return body.data ?? [];
  }

  /**
   * Convenience pass-through to list managed DHIS2 instances the user
   * can clone from. Filters to running instances since `pg_dump` against
   * a stopped DB is not possible.
   */
  async listManagedInstances(): Promise<DHIS2Instance[]> {
    const all = await dhis2Service.getInstances();
    return all.filter(i => i.status === 'running');
  }

  /**
   * Trigger a restore on an existing instance. The backend stops Tomcat,
   * drops + recreates the DB, applies the dump, and restarts Tomcat.
   *
   * Backend contract:
   *   POST {baseUrl}/instances/{id}/restore   body: RestoreSource
   *   200 : RestoreJob
   */
  async restoreExistingInstance(
    instanceId: string,
    source: RestoreSource,
  ): Promise<RestoreJob> {
    const url = `${this.baseUrl}/instances/${encodeURIComponent(
      instanceId,
    )}/restore`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed.error === 'string') detail = parsed.error;
      } catch {
        /* keep status line */
      }
      throw new Error(`Restore request failed: ${detail}`);
    }
    return (await res.json()) as RestoreJob;
  }
}

export const restoreService = new RestoreService();
