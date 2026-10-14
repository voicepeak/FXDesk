import type { ServerResponse } from 'node:http';
import { getDb } from './db';
import type { JobRow, RunRow } from './types';

type Client = { id: number; res: ServerResponse };

class EventBus {
  private clients = new Set<Client>();
  private nextId = 1;

  add(res: ServerResponse): Client {
    const c: Client = { id: this.nextId++, res };
    this.clients.add(c);
    return c;
  }

  remove(c: Client): void {
    this.clients.delete(c);
  }

  broadcast(type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try {
        c.res.write(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

export const bus = new EventBus();

export interface JobUpdatePayload {
  jobId: string;
  name: string;
  thumb: string | null;
  status: string;
  stage: string | null;
  elapsed: number | null;
  cost: number;
  error?: string | null;
}

export function buildJobUpdate(jobId: string, extra?: { stage?: string | null; elapsed?: number | null; error?: string | null }): JobUpdatePayload | null {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return null;
  const lastRun = db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY seq DESC LIMIT 1').get(jobId) as RunRow | undefined;
  return {
    jobId: job.id,
    name: job.name,
    thumb: job.original_path ? `/api/files/${job.original_path}` : null,
    status: job.status,
    stage: extra?.stage ?? null,
    elapsed: extra?.elapsed ?? lastRun?.elapsed_ms ?? null,
    cost: job.cost_total,
    error: extra?.error ?? lastRun?.error ?? null,
  };
}

export function emitJobUpdate(jobId: string, extra?: { stage?: string | null; elapsed?: number | null; error?: string | null }): void {
  const payload = buildJobUpdate(jobId, extra);
  if (payload) bus.broadcast('job_update', payload);
}

export function emitRunProgress(runId: string, jobId: string, stage: string, elapsedMs: number, pct?: number, details?: { attempt?: number; message?: string; retryAt?: number }): void {
  bus.broadcast('run_progress', { runId, jobId, stage, elapsedMs, pct: pct ?? null, ...details });
}

export function emitLibUpdate(reason: string, itemId?: string): void {
  bus.broadcast('lib_update', { reason, itemId: itemId ?? null });
}
