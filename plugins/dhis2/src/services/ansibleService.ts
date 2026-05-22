import { CreateInstanceRequest } from '../types';

/**
 * Status of an Ansible provisioning task.
 */
export type AnsibleTaskStatus =
  | 'queued'
  | 'creating-container'
  | 'running-ansible'
  | 'configuring-proxy'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Single log line emitted by the provisioning pipeline.
 * Source identifies which phase produced the line so the UI can colour-code.
 */
export interface AnsibleLogLine {
  ts: string;
  source: 'create-container' | 'ansible' | 'host-proxy' | 'orchestrator';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface AnsibleTask {
  taskId: string;
  vmid: string;
  status: AnsibleTaskStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  containerIp?: string;
}

export interface ProvisionParams extends CreateInstanceRequest {
  /** Default false. When true, the orchestrator destroys the container if any phase fails. */
  rollbackOnFailure?: boolean;
  /** Default false. */
  enableMonitoring?: boolean;
  /** Default false. */
  enableBackups?: boolean;
  /** Default false. */
  skipCertbot?: boolean;
}

/**
 * Frontend service that drives the hybrid Bash + Ansible provisioning flow.
 *
 * The actual orchestration lives in `plugins/dhis2/scripts/create-instance.sh`
 * which is invoked by a (forthcoming) `dhis2-backend` plugin via
 * `child_process.spawn`. This frontend class is a thin REST client that
 * posts a provision request to that backend and streams progress back.
 *
 * Until the backend exists, the methods return mocked task objects so the
 * UI can be developed in isolation — same pattern as
 * `./proxmoxService.ts` and `./nginxService.ts`.
 */
export class AnsibleService {
  constructor(
    private readonly baseUrl: string = '/api/dhis2',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Kick off a new provisioning run.
   *
   * Backend contract (when implemented):
   *   POST {baseUrl}/provision
   *   body: ProvisionParams (secrets ARE in the body; the backend forwards
  *         them via env vars to create-instance.sh — they never appear
   *         in `ps`).
   *   200 : AnsibleTask
   */
  async provisionInstance(params: ProvisionParams): Promise<AnsibleTask> {
    // Stub: in production this hits the backend route above. For now we
    // mint a deterministic taskId so the UI can render an in-progress card.
    const taskId = `ansible-${Date.now()}`;
    return {
      taskId,
      vmid: '', // backend assigns the next available VMID
      status: 'queued',
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Poll task status. The UI also has `streamLogs` for live output.
   *
   * Backend contract:
   *   GET {baseUrl}/provision/{taskId} -> AnsibleTask
   */
  async getTask(taskId: string): Promise<AnsibleTask | null> {
    void this.baseUrl;
    void this.fetchImpl;
    void taskId;
    return null;
  }

  /**
  * Stream stdout/stderr from the running create-instance.sh as
   * structured log lines (one per Server-Sent-Event / newline-delimited JSON).
   *
   * Backend contract:
   *   GET {baseUrl}/provision/{taskId}/logs (Content-Type: application/x-ndjson)
   *
   * The frontend should consume this with `Response.body.getReader()` and
   * push each `AnsibleLogLine` into a log viewer. Implementation deferred
   * until the backend exists.
   */
  async *streamLogs(_taskId: string): AsyncGenerator<AnsibleLogLine, void> {
    // Stub: yields nothing until the backend is wired up.
    return;
  }

  /**
   * Cancel a running task. Sends SIGTERM to the bash orchestrator; if the
   * task was started with `rollbackOnFailure=true` the backend also runs
   * `pct destroy` and removes the central-Nginx site file.
   *
   * Backend contract:
   *   POST {baseUrl}/provision/{taskId}/cancel -> AnsibleTask
   */
  async cancel(taskId: string): Promise<AnsibleTask | null> {
    void taskId;
    return null;
  }
}

export const ansibleService = new AnsibleService();
