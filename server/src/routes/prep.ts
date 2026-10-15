import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { isMockMode, loadSettings, resolveEffectSettings } from '../settings';
import { queueManager } from '../queue';
import { emitJobUpdate, emitPrepUpdate } from '../sse';
import { logEvent } from '../logger';
import { apiError } from './jobs';
import {
  approveEffect,
  defaultEffectRefs,
  ensurePrepRow,
  listJobEffects,
  startAnalysis,
  startProposal,
  isMaterialRole,
} from '../prep';
import type { AnalysisResult, EffectKind, JobEffectRow, JobRow, MaterialRow, PrepTaskStatus } from '../types';

const KINDS: EffectKind[] = ['light', 'prop', 'background', 'other'];

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function effectDto(row: JobEffectRow) {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    kind: row.kind,
    genPrompt: row.gen_prompt,
    blendPrompt: row.blend_prompt,
    refMaterialIds: parseJson<string[]>(row.ref_material_ids, []),
    status: row.status,
    runId: row.run_id,
    imageUrl: row.image_path ? `/api/files/${row.image_path}` : null,
    error: row.error,
    libraryItemId: row.library_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function friendlyPrepError(e: string | null): string | null {
  return e === 'interrupted' ? '服务重启导致任务中断，请重新执行' : e;
}

function prepDto(jobId: string) {
  const prep = ensurePrepRow(jobId);
  return {
    analysis: {
      status: prep.analysis_status as PrepTaskStatus,
      result: parseJson<AnalysisResult | null>(prep.analysis_result, null),
      error: friendlyPrepError(prep.analysis_error),
      confirmedAt: prep.analysis_confirmed_at,
      startedAt: prep.analysis_started_at,
      finishedAt: prep.analysis_finished_at,
    },
    proposal: {
      status: prep.proposal_status as PrepTaskStatus,
      result: parseJson<{ summary: string; effects: unknown[] } | null>(prep.proposal_result, null),
      error: friendlyPrepError(prep.proposal_error),
      startedAt: prep.proposal_started_at,
      finishedAt: prep.proposal_finished_at,
    },
  };
}

export function registerPrepRoutes(app: FastifyInstance): void {
  app.get('/api/jobs/:id/prep', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    return { prep: prepDto(id), effects: listJobEffects(id).map(effectDto) };
  });

  app.post('/api/jobs/:id/prep/analyze', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const r = startAnalysis(id);
    return { ok: true, status: r.status };
  });

  app.put('/api/jobs/:id/prep/analysis', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const prep = ensurePrepRow(id);
    const body = (req.body ?? {}) as Partial<AnalysisResult>;
    const current = parseJson<AnalysisResult | null>(prep.analysis_result, null);
    const merged: AnalysisResult = {
      character: String(body.character ?? current?.character ?? '').trim().slice(0, 80),
      work: String(body.work ?? current?.work ?? '').trim().slice(0, 120),
      aliases: Array.isArray(body.aliases)
        ? body.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 6)
        : current?.aliases ?? [],
      scene: String(body.scene ?? current?.scene ?? '').trim().slice(0, 400),
      confidence: current?.confidence ?? null,
      notes: String(body.notes ?? current?.notes ?? '').trim().slice(0, 300),
    };
    const now = Date.now();
    db.prepare('UPDATE job_preps SET analysis_result=?, analysis_confirmed_at=?, updated_at=? WHERE job_id=?').run(
      JSON.stringify(merged),
      now,
      now,
      id
    );
    if (merged.character && merged.character !== job.character) {
      db.prepare('UPDATE jobs SET character=?, updated_at=? WHERE id=?').run(merged.character, now, id);
    }
    emitPrepUpdate({ jobId: id, kind: 'analysis', status: 'done' });
    emitJobUpdate(id);
    return { ok: true, analysis: merged };
  });

  app.post('/api/jobs/:id/prep/propose', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const r = startProposal(id);
    if (r.status === 'no_analysis') throw apiError(400, 'ANALYSIS_REQUIRED', '请先完成角色识别分析，再生成特效见解');
    return { ok: true, status: r.status };
  });

  /* ---------------- 特效条目 ---------------- */

  app.post('/api/jobs/:id/prep/effects', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as { title?: string; kind?: string; genPrompt?: string; blendPrompt?: string };
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM job_effects WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;
    const now = Date.now();
    const effectId = randomUUID();
    const kindRaw = String(body.kind ?? 'other') as EffectKind;
    db.prepare(
      "INSERT INTO job_effects (id, job_id, seq, title, kind, gen_prompt, blend_prompt, ref_material_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)"
    ).run(
      effectId,
      id,
      seq,
      String(body.title ?? '').trim().slice(0, 60) || `特效 ${seq}`,
      KINDS.includes(kindRaw) ? kindRaw : 'other',
      String(body.genPrompt ?? '').trim().slice(0, 2000),
      String(body.blendPrompt ?? '').trim().slice(0, 1000),
      JSON.stringify(defaultEffectRefs(materials)),
      now,
      now
    );
    emitPrepUpdate({ jobId: id, kind: 'effect', status: 'ready', effectId });
    const row = db.prepare('SELECT * FROM job_effects WHERE id=?').get(effectId) as JobEffectRow;
    return { ok: true, effect: effectDto(row) };
  });

  app.put('/api/jobs/:id/prep/effects/:eid', async (req) => {
    const db = getDb();
    const { id, eid } = req.params as { id: string; eid: string };
    const effect = db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(eid, id) as JobEffectRow | undefined;
    if (!effect) throw apiError(404, 'EFFECT_NOT_FOUND', '特效条目不存在');
    if (['queued', 'generating'].includes(effect.status)) throw apiError(409, 'EFFECT_BUSY', '特效正在生成中，无法编辑');
    if (effect.status === 'approved') throw apiError(409, 'EFFECT_APPROVED', '已入库的特效请在素材库中编辑');
    const body = (req.body ?? {}) as { title?: string; kind?: string; genPrompt?: string; blendPrompt?: string; refMaterialIds?: string[] };
    const kindRaw = body.kind !== undefined ? (String(body.kind) as EffectKind) : effect.kind;
    const validMats = new Set((db.prepare('SELECT id FROM job_materials WHERE job_id=?').all(id) as { id: string }[]).map((m) => m.id));
    const refIds = body.refMaterialIds !== undefined
      ? body.refMaterialIds.map(String).filter((mid) => validMats.has(mid))
      : parseJson<string[]>(effect.ref_material_ids, []);
    db.prepare('UPDATE job_effects SET title=?, kind=?, gen_prompt=?, blend_prompt=?, ref_material_ids=?, updated_at=? WHERE id=?').run(
      body.title !== undefined ? String(body.title).trim().slice(0, 60) : effect.title,
      KINDS.includes(kindRaw) ? kindRaw : 'other',
      body.genPrompt !== undefined ? String(body.genPrompt).trim().slice(0, 2000) : effect.gen_prompt,
      body.blendPrompt !== undefined ? String(body.blendPrompt).trim().slice(0, 1000) : effect.blend_prompt,
      JSON.stringify(refIds),
      Date.now(),
      eid
    );
    const row = db.prepare('SELECT * FROM job_effects WHERE id=?').get(eid) as JobEffectRow;
    return { ok: true, effect: effectDto(row) };
  });

  app.delete('/api/jobs/:id/prep/effects/:eid', async (req) => {
    const db = getDb();
    const { id, eid } = req.params as { id: string; eid: string };
    const effect = db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(eid, id) as JobEffectRow | undefined;
    if (!effect) throw apiError(404, 'EFFECT_NOT_FOUND', '特效条目不存在');
    if (['queued', 'generating', 'approved'].includes(effect.status)) {
      throw apiError(409, 'EFFECT_NOT_DELETABLE', effect.status === 'approved' ? '已入库的特效不能删除' : '生成中的特效不能删除');
    }
    db.prepare('DELETE FROM job_effects WHERE id=?').run(eid);
    emitPrepUpdate({ jobId: id, kind: 'effect', status: 'deleted', effectId: eid });
    return { ok: true };
  });

  app.post('/api/jobs/:id/prep/effects/:eid/generate', async (req) => {
    const db = getDb();
    const { id, eid } = req.params as { id: string; eid: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const effect = db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(eid, id) as JobEffectRow | undefined;
    if (!effect) throw apiError(404, 'EFFECT_NOT_FOUND', '特效条目不存在');
    if (['queued', 'generating'].includes(effect.status)) throw apiError(409, 'EFFECT_BUSY', '该特效正在生成中');
    if (effect.status === 'approved') throw apiError(409, 'EFFECT_APPROVED', '已入库的特效不能重新生成');
    if (!effect.gen_prompt.trim()) throw apiError(400, 'EFFECT_EMPTY_PROMPT', '请先填写生成描述再生成特效图');
    const settings = loadSettings();
    const effectSettings = resolveEffectSettings(settings);
    if (!isMockMode(settings) && !effectSettings.apiKey) throw apiError(400, 'NO_API_KEY', '未配置特效服务 API Key（设置页「AI 筹备」，留空则沿用上方连接配置）');
    if (!isMockMode(settings) && !settings.effectModelId.trim()) throw apiError(400, 'NO_EFFECT_MODEL', '未配置特效模型 ID（设置页「AI 筹备」）');

    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;
    const runId = randomUUID();
    db.prepare("INSERT INTO runs (id, job_id, seq, type, status, request_json, created_at) VALUES (?, ?, ?, 'effect', 'queued', ?, ?)").run(
      runId,
      id,
      seq,
      JSON.stringify({ effectId: eid }),
      Date.now()
    );
    db.prepare("UPDATE job_effects SET status='queued', run_id=?, error=NULL, updated_at=? WHERE id=?").run(runId, Date.now(), eid);
    queueManager.enqueue(id, runId);
    logEvent('info', `特效预演入队：${effect.title}（Run ${seq}）`, { jobId: id, runId });
    emitPrepUpdate({ jobId: id, kind: 'effect', status: 'queued', effectId: eid });
    emitJobUpdate(id, { stage: 'queued' });
    return { runId, seq };
  });

  app.post('/api/jobs/:id/prep/effects/:eid/approve', async (req) => {
    const { id, eid } = req.params as { id: string; eid: string };
    const result = await approveEffect(id, eid);
    return { ok: true, ...result };
  });
}
