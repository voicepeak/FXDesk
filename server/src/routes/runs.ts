import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { queueManager } from '../queue';
import { emitJobUpdate, emitPrepUpdate } from '../sse';
import { logEvent } from '../logger';
import { apiError } from './jobs';
import type { JobEffectRow, JobRow, RunRow } from '../types';
import { getResultLocation, revealResult } from '../resultLocation';

export function registerRunsRoutes(app: FastifyInstance): void {
  app.get('/api/runs/:id/location', async (req) => {
    return getResultLocation((req.params as { id: string }).id);
  });

  app.post('/api/runs/:id/reveal', async (req) => {
    const origin = req.headers.origin;
    if (origin) {
      let local = false;
      try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); } catch { /* reject */ }
      if (!local) throw apiError(403, 'FORBIDDEN', '仅允许本地页面打开文件位置');
    }
    return revealResult((req.params as { id: string }).id);
  });

  app.get('/api/queue', async () => {
    return queueManager.snapshot();
  });

  app.post('/api/runs/:id/retry', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined;
    if (!run) throw apiError(404, 'RUN_NOT_FOUND', 'Run 不存在');
    if (run.status !== 'failed' && run.status !== 'canceled') throw apiError(400, 'RUN_NOT_RETRYABLE', '仅失败的 Run 可重试');
    if (run.type === 'faceRepair') throw apiError(400, 'RUN_NOT_RETRYABLE', '面部重修请通过重跑（rerun）执行');
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(run.job_id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');

    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id=?').get(run.job_id) as { m: number | null }).m ?? 0) + 1;
    const newId = randomUUID();

    if (run.type === 'effect') {
      let effectId = '';
      try {
        effectId = (JSON.parse(run.request_json ?? '{}') as { effectId?: string }).effectId ?? '';
      } catch {
        effectId = '';
      }
      const effect = effectId ? (db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(effectId, run.job_id) as JobEffectRow | undefined) : undefined;
      if (!effect) throw apiError(400, 'EFFECT_NOT_FOUND', '特效条目已不存在，无法重试');
      if (effect.status === 'approved') throw apiError(400, 'EFFECT_APPROVED', '已入库的特效不能重新生成');
      db.prepare("INSERT INTO runs (id, job_id, seq, type, status, request_json, created_at) VALUES (?, ?, ?, 'effect', 'queued', ?, ?)").run(
        newId,
        run.job_id,
        seq,
        JSON.stringify({ effectId }),
        Date.now()
      );
      db.prepare("UPDATE job_effects SET status='queued', run_id=?, error=NULL, updated_at=? WHERE id=?").run(newId, Date.now(), effectId);
      queueManager.enqueue(run.job_id, newId);
      logEvent('info', `重试特效预演（原 ${run.seq} → 新 ${seq}）`, { jobId: run.job_id, runId: newId });
      emitPrepUpdate({ jobId: run.job_id, kind: 'effect', status: 'queued', effectId });
      emitJobUpdate(run.job_id, { stage: 'queued' });
      return { runId: newId, seq };
    }

    db.prepare('INSERT INTO runs (id, job_id, seq, type, status, base_run_id, request_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      newId,
      run.job_id,
      seq,
      run.type,
      'queued',
      run.base_run_id,
      run.type === 'repair' ? run.request_json : null,
      Date.now()
    );
    db.prepare("UPDATE jobs SET status='queued', updated_at=? WHERE id=?").run(Date.now(), run.job_id);
    queueManager.enqueue(run.job_id, newId);
    logEvent('info', `重试 Run（原 ${run.seq} → 新 ${seq}）`, { jobId: run.job_id, runId: newId });
    emitJobUpdate(run.job_id, { stage: 'queued' });
    return { runId: newId, seq };
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const r = queueManager.cancelRun(id);
    if (!r.ok) throw apiError(400, r.error ?? 'CANCEL_FAILED', '当前状态不可取消');
    return { ok: true };
  });

  app.post('/api/runs/:id/elements', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined;
    if (!run) throw apiError(404, 'RUN_NOT_FOUND', 'Run 不存在');
    const body = (req.body ?? {}) as { elements?: { label: string; checked: boolean }[] };
    if (!Array.isArray(body.elements)) throw apiError(400, 'NO_ELEMENTS', '缺少 elements 数组');
    const qc = run.qc_json ? JSON.parse(run.qc_json) : { identity: { status: 'skipped', sim: null }, composition: null, elements: { confirmed: [] } };
    qc.elements = { confirmed: body.elements.map((e) => ({ label: String(e.label), checked: !!e.checked })) };
    db.prepare('UPDATE runs SET qc_json=? WHERE id=?').run(JSON.stringify(qc), id);
    return { ok: true, elements: qc.elements };
  });

  app.post('/api/runs/:id/review', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined;
    if (!run) throw apiError(404, 'RUN_NOT_FOUND', 'Run 不存在');
    const body = (req.body ?? {}) as { action?: string; note?: string };
    const action = String(body.action ?? 'note');
    db.prepare('INSERT INTO reviews (id, run_id, action, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      id,
      action,
      String(body.note ?? ''),
      Date.now()
    );
    return { ok: true };
  });

  app.get('/api/runs/:id/reviews', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const rows = db.prepare('SELECT * FROM reviews WHERE run_id=? ORDER BY created_at').all(id);
    return { reviews: rows };
  });
}
