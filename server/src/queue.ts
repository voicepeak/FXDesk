import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { getDb } from './db';
import { abs, rel, ws } from './env';
import { loadSettings, resolveEffectSettings, type AppSettings } from './settings';
import { logEvent, logLine } from './logger';
import { assemblePrompt, applyTemplate, colorName, locationOf, parseBbox, parseTokens } from './prompt';
import type { AssembleTemplates } from './prompt';
import { renderMarkers } from './markers';
import { canvasConstraint, closestAspectRatio } from './imageGeometry';
import { generateWithFallback, MomoError, type ImagePart } from './momo';
import { runIdentityCheck } from './qc';
import { analyzeComposition } from './qc/composition';
import { performFaceRepair } from './qc/faceRepair';
import { applyFaceLock } from './qc/faceLock';
import { cosineSimilarity, embedFace } from './qc/faces';
import { upscaleToOriginal } from './upscale';
import { extractNouns } from './tagging';
import { emitJobUpdate, emitPrepUpdate, emitRunProgress } from './sse';
import { notifyComplete, notifyFail } from './notify';
import { materialRoleLabel } from './prep';
import type { Bbox, JobEffectRow, JobRow, MaterialRow, QcResult, RegionRow, RunRow } from './types';

export function runDirName(seq: number): string {
  return `run_${String(seq).padStart(4, '0')}`;
}

interface ActiveInfo {
  jobId: string;
  runId: string;
  runType: string;
  stage: string;
  startedAt: number;
  cancelRequested?: boolean;
  attempt?: number;
  message?: string;
  retryAt?: number;
  timeoutSec?: number;
  imageSize?: string;
  effectId?: string;
}

interface RunPrep {
  images: ImagePart[];
  prompt: string;
  aspectRatio: string;
  mockReturn: ImagePart;
  markerPath: string | null;
  requestMeta: Record<string, unknown>;
}

const TOTAL_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB 合计上限（§7.1）

export class QueueManager {
  private q = new PQueue({ concurrency: 2 });
  private pendingJobs: { jobId: string; runId: string }[] = [];
  private active = new Map<string, ActiveInfo>();
  private aborts = new Map<string, AbortController>();

  constructor() {
    this.applyConcurrency();
  }

  applyConcurrency(): void {
    const n = loadSettings().queueConcurrency;
    this.q.concurrency = Math.min(4, Math.max(1, n));
  }

  enqueue(jobId: string, runId: string): void {
    this.pendingJobs.push({ jobId, runId });
    emitJobUpdate(jobId, { stage: 'queued' });
    void this.q.add(() => this.process(jobId, runId)).catch(() => undefined);
  }

  get position(): (jobId: string) => number | null {
    return (jobId: string) => {
      const i = this.pendingJobs.findIndex((p) => p.jobId === jobId);
      return i < 0 ? null : i + 1;
    };
  }

  private removePending(runId: string): void {
    this.pendingJobs = this.pendingJobs.filter((p) => p.runId !== runId);
  }

  cancelRun(runId: string): { ok: boolean; error?: string } {
    const db = getDb();
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
    if (run.status === 'queued') {
      this.removePending(runId);
      db.prepare("UPDATE runs SET status='canceled', error='canceled', finished_at=? WHERE id=?").run(Date.now(), runId);
      if (run.type === 'effect') {
        const effectId = effectIdOf(run);
        if (effectId) {
          db.prepare("UPDATE job_effects SET status='ready', error=NULL, updated_at=? WHERE id=?").run(Date.now(), effectId);
          emitPrepUpdate({ jobId: run.job_id, kind: 'effect', status: 'ready', effectId });
        }
        emitJobUpdate(run.job_id);
        return { ok: true };
      }
      db.prepare("UPDATE jobs SET status='canceled', updated_at=? WHERE id=?").run(Date.now(), run.job_id);
      emitJobUpdate(run.job_id, { stage: 'canceled' });
      return { ok: true };
    }
    if (run.status === 'generating' || run.status === 'qc') {
      const info = this.active.get(run.job_id);
      if (info) info.cancelRequested = true;
      this.aborts.get(runId)?.abort(new Error('canceled'));
      return { ok: true };
    }
    return { ok: false, error: 'RUN_NOT_CANCELABLE' };
  }

  /** 启动时恢复：未完成的 Run/Job 标记 failed(interrupted)（§4.8.5） */
  recoverInterrupted(): number {
    const db = getDb();
    const now = Date.now();
    const r1 = db
      .prepare("UPDATE runs SET status='failed', error='interrupted', finished_at=? WHERE status IN ('queued','generating','qc')")
      .run(now);
    const r2 = db
      .prepare("UPDATE jobs SET status='failed', updated_at=? WHERE status IN ('queued','generating','qc','repairing')")
      .run(now);
    return r1.changes + r2.changes;
  }

  snapshot() {
    const db = getDb();
    const settings = loadSettings();
    const jobsOf = (ids: { jobId: string; runId: string }[]) =>
      ids.map(({ jobId, runId }, i) => {
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
        const run = db.prepare('SELECT type FROM runs WHERE id = ?').get(runId) as { type: string } | undefined;
        return job
          ? { jobId: job.id, runId, name: job.name, runType: run?.type ?? 'initial', thumb: job.original_path ? `/api/files/${job.original_path}` : null, position: i + 1 }
          : null;
      }).filter(Boolean);

    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1).getTime();
    const todayCost = (db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM runs WHERE created_at >= ?').get(startToday.getTime()) as { c: number }).c;
    const monthlyCost = (db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM runs WHERE created_at >= ?').get(startMonth) as { c: number }).c;

    return {
      concurrency: this.q.concurrency,
      pending: jobsOf(this.pendingJobs),
      active: [...this.active.values()].map((a) => {
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(a.jobId) as JobRow | undefined;
        return {
          jobId: a.jobId,
          runId: a.runId,
          name: job?.name ?? a.jobId,
          runType: a.runType,
          thumb: job?.original_path ? `/api/files/${job.original_path}` : null,
          stage: a.stage,
          elapsed: Date.now() - a.startedAt,
          cost: job?.cost_total ?? 0,
          startedAt: a.startedAt,
          attempt: a.attempt,
          message: a.message,
          retryAt: a.retryAt,
          timeoutSec: a.timeoutSec,
          imageSize: a.imageSize,
        };
      }),
      todayCost,
      monthlyCost,
      mock: settings.mockApi,
    };
  }

  private async process(jobId: string, runId: string): Promise<void> {
    const db = getDb();
    // PQueue cannot remove a queued callback; a canceled run must never reach the paid API.
    const queuedRun = db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
    if (queuedRun?.status !== 'queued') return;
    this.removePending(runId);
    const ctrl = new AbortController();
    this.aborts.set(runId, ctrl);
    const startedAt = Date.now();
    const info: ActiveInfo = { jobId, runId, runType: 'initial', stage: 'uploading', startedAt };
    this.active.set(jobId, info);
    const stage = (s: string) => {
      info.stage = s;
      if (!['generating', 'retrying', 'upscaling'].includes(s)) { info.message = undefined; info.retryAt = undefined; }
      const elapsed = Date.now() - startedAt;
      emitRunProgress(runId, jobId, s, elapsed, undefined, { attempt: info.attempt, message: info.message, retryAt: info.retryAt });
      emitJobUpdate(jobId, { stage: s, elapsed });
    };

    try {
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
      if (!run || !job) throw new Error('run/job 不存在');
      const settings = loadSettings();
      info.runType = run.type;
      info.timeoutSec = settings.runTimeoutSec;
      info.imageSize = settings.imageSize;

      if (run.type === 'effect') {
        info.effectId = effectIdOf(run) ?? undefined;
        await this.processEffect(job, run, settings, ctrl, info, stage, startedAt);
        return;
      }

      const isRepair = run.type === 'repair';
      db.prepare("UPDATE runs SET status='generating' WHERE id=?").run(runId);
      db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(isRepair ? 'repairing' : 'generating', Date.now(), jobId);
      emitJobUpdate(jobId, { stage: 'uploading' });

      stage('uploading');
      const prep = await this.prepareRun(job, run, settings);
      db.prepare('UPDATE runs SET marker_path=?, final_prompt=? WHERE id=?').run(prep.markerPath, prep.prompt, runId);

      stage('generating');
      const gen = await generateWithFallback({
        images: prep.images,
        prompt: prep.prompt,
        signal: ctrl.signal,
        settings,
        aspectRatio: prep.aspectRatio,
        mockReturn: prep.mockReturn,
        context: { jobId, runId },
        onProgress: (progress) => {
          info.attempt = progress.attempt;
          info.message = progress.message;
          info.retryAt = progress.retryAt;
          stage(progress.stage);
        },
      });

      stage('downloading');
      const ext = /jpe?g/i.test(gen.mime) ? 'jpg' : 'png';
      const runDir = ws('jobs', jobId, '02_runs', runDirName(run.seq));
      fs.mkdirSync(runDir, { recursive: true });
      const resultAbs = path.join(runDir, `result.${ext}`);
      fs.writeFileSync(resultAbs, Buffer.from(gen.base64, 'base64'));

      const runCost = settings.pricePerImage;
      db.prepare('UPDATE runs SET result_path=?, result_final_path=?, cost=cost+?, elapsed_ms=? WHERE id=?').run(
        rel(resultAbs),
        rel(resultAbs),
        runCost,
        Date.now() - startedAt,
        runId
      );
      db.prepare('UPDATE jobs SET cost_total = cost_total + ?, updated_at=? WHERE id=?').run(runCost, Date.now(), jobId);

      const origAbs = abs(job.original_path);
      stage('upscaling');
      let finalAbs = resultAbs;
      try {
        const original = await ensureOriginalSize(job, origAbs);
        const upscaleOut = path.join(runDir, 'result_final.png');
        const upsc = await upscaleToOriginal({
          srcPath: resultAbs,
          outPath: upscaleOut,
          origPath: origAbs,
          origW: original.width,
          origH: original.height,
          engine: settings.upscaleEngine,
          timeoutSec: settings.upscaleTimeoutSec,
          signal: ctrl.signal,
          onProgress: (message) => {
            info.message = message;
            stage('upscaling');
          },
        });
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        finalAbs = upscaleOut;
        prep.requestMeta.upscale = upsc;
        db.prepare('UPDATE runs SET result_final_path=?, upscale_json=? WHERE id=?').run(rel(upscaleOut), JSON.stringify(upsc), runId);
        logEvent('info', `超分回填完成（${upsc.engine}${upsc.degraded ? '·已降级' : ''}）：${upsc.from} → ${upsc.to}，耗时 ${Math.round(upsc.elapsedMs / 1000)} 秒`, { jobId, runId });
        emitJobUpdate(jobId, { stage: 'upscaling', elapsed: Date.now() - startedAt });
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof MomoError && e.code === 'CANCELED')) throw e;
        if (e instanceof MomoError && e.code === 'UPSCALE_FAILED') throw e;
        throw new MomoError('UPSCALE_FAILED', e instanceof Error ? e.message : String(e));
      }

      stage('qc');
      db.prepare("UPDATE runs SET status='qc' WHERE id=?").run(runId);
      db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(isRepair ? 'repairing' : 'qc', Date.now(), jobId);

      const qc: QcResult = {
        identity: { status: 'skipped', sim: null, reason: null, passThreshold: settings.qcIdentityPass, midThreshold: settings.qcIdentityMid },
        composition: null,
        elements: { confirmed: [] },
        faceRepair: null,
      };

      try {
        qc.composition = await analyzeComposition(origAbs, finalAbs);
      } catch (e) {
        logLine('warn', `构图检测失败：${String(e)}`);
      }

      let finalRunId = runId;
      try {
        const idr = await runIdentityCheck(origAbs, finalAbs, settings);
        qc.identity = idr.identity;
        if (idr.shouldRepair) {
          const fr = await this.runFaceRepairInline(job, run, origAbs, finalAbs, settings, qc, startedAt);
          if (fr) {
            finalAbs = fr.finalAbs;
            finalRunId = fr.runId;
          }
        }
      } catch (e) {
        logLine('warn', `身份检测失败：${String(e)}`);
      }

      // 最后一步（§4.7.5 锁脸）：无论重修与否，都把原图脸区对齐贴回（复制图层）+ 光照匹配，
      // 复检后以 qcFaceLockPass（默认 0.95）为硬门槛；这是交付前的最后一道图像操作。
      if (settings.qcFaceLock) {
        try {
          const lockRun = db.prepare('SELECT * FROM runs WHERE id=?').get(finalRunId) as RunRow | undefined;
          const lockDir = ws('jobs', jobId, '02_runs', runDirName(lockRun?.seq ?? run.seq));
          fs.mkdirSync(lockDir, { recursive: true });
          const lockedAbs = path.join(lockDir, 'result_locked.png');
          const lockStartedAt = Date.now();
          const lock = await applyFaceLock({ origAbs, resultAbs: finalAbs, outAbs: lockedAbs });
          if (lock.applied) {
            // 复检按“对齐后实际落点”采样（不再经检测器二次抖动，尤其是发丝遮挡眼周时）
            const simBefore = qc.identity.sim;
            let simAfter: number | null = null;
            if (lock.origKps && lock.placedKps) {
              const [eo, el] = await Promise.all([embedFace(origAbs, lock.origKps), embedFace(lockedAbs, lock.placedKps)]);
              simAfter = Number(cosineSimilarity(eo, el).toFixed(4));
            } else {
              const recheck = await runIdentityCheck(origAbs, lockedAbs, { ...settings, qcAutoFaceRepair: false });
              simAfter = recheck.identity.sim;
            }
            const pass = simAfter != null && simAfter >= settings.qcFaceLockPass;
            qc.identity.afterLock = { sim: simAfter, status: pass ? 'pass' : 'fail' };
            qc.identity.status = pass ? 'pass' : 'fail';
            qc.faceLock = {
              applied: true,
              simBefore,
              simAfter,
              pass,
              passThreshold: settings.qcFaceLockPass,
              simMethod: lock.origKps && lock.placedKps ? 'aligned' : 'detected',
              runId: finalRunId,
              path: rel(lockedAbs),
              angleDeg: lock.angleDeg,
              scale: lock.scale,
              alignResidual: lock.alignResidual,
              lightMatch: lock.lightMatch,
              elapsedMs: Date.now() - lockStartedAt,
            };
            finalAbs = lockedAbs;
            db.prepare('UPDATE runs SET result_final_path=? WHERE id=?').run(rel(lockedAbs), finalRunId);
            const owner = db.prepare('SELECT qc_json FROM runs WHERE id=?').get(finalRunId) as { qc_json: string | null } | undefined;
            if (owner?.qc_json) {
              try {
                const oq = JSON.parse(owner.qc_json) as QcResult;
                oq.identity.afterLock = qc.identity.afterLock;
                oq.identity.status = qc.identity.status;
                oq.faceLock = qc.faceLock;
                db.prepare('UPDATE runs SET qc_json=? WHERE id=?').run(JSON.stringify(oq), finalRunId);
                fs.writeFileSync(path.join(lockDir, 'qc.json'), JSON.stringify(oq, null, 2), 'utf8');
              } catch {
                /* ignore */
              }
            }
            logEvent('info', `锁脸完成：${simBefore ?? '—'} → ${simAfter ?? '—'}（门槛 ${settings.qcFaceLockPass}，${pass ? '通过' : '未达标'}）`, { jobId, runId });
          } else {
            qc.faceLock = { applied: false, reason: lock.reason };
            logLine('warn', `锁脸未执行（保持原结果）：${lock.reason}`);
          }
        } catch (e) {
          qc.faceLock = { applied: false, reason: e instanceof Error ? e.message : String(e) };
          logLine('warn', `锁脸失败（保持原结果）：${String(e)}`);
        }
      }

      qc.elements.confirmed = this.suggestElements(jobId);

      const qcPath = path.join(runDir, 'qc.json');
      fs.writeFileSync(qcPath, JSON.stringify(qc, null, 2), 'utf8');
      db.prepare('UPDATE runs SET qc_json=? WHERE id=?').run(JSON.stringify(qc), runId);
      db.prepare('UPDATE runs SET status=?, finished_at=?, elapsed_ms=? WHERE id=?').run('done', Date.now(), Date.now() - startedAt, runId);
      db.prepare('UPDATE jobs SET status=?, final_run_id=?, updated_at=? WHERE id=?').run('review', finalRunId, Date.now(), jobId);

      this.writeRequestJson(job, run, prep, startedAt, runCost, undefined);
      logEvent('info', `Run 完成（${run.type}）`, { jobId, runId });
      emitJobUpdate(jobId, { stage: 'review', elapsed: Date.now() - startedAt });
      notifyComplete(job.name);
    } catch (e) {
      const canceled = ctrl.signal.aborted || (e instanceof MomoError && e.code === 'CANCELED');
      const db2 = getDb();
      if (info.runType === 'effect') {
        const effectId = info.effectId ?? null;
        if (canceled) {
          db2.prepare("UPDATE runs SET status='canceled', error='canceled', finished_at=? WHERE id=?").run(Date.now(), runId);
          if (effectId) db2.prepare("UPDATE job_effects SET status='ready', error=NULL, updated_at=? WHERE id=?").run(Date.now(), effectId);
          emitPrepUpdate({ jobId, kind: 'effect', status: 'ready', effectId });
        } else {
          const friendly = friendlyError(e);
          db2.prepare('UPDATE runs SET status=?, error=?, finished_at=?, elapsed_ms=? WHERE id=?').run('failed', friendly, Date.now(), Date.now() - startedAt, runId);
          if (effectId) db2.prepare("UPDATE job_effects SET status='failed', error=?, updated_at=? WHERE id=?").run(friendly, Date.now(), effectId);
          logEvent('error', `特效预演失败：${friendly}`, { jobId, runId });
          emitPrepUpdate({ jobId, kind: 'effect', status: 'failed', effectId, error: friendly });
          emitJobUpdate(jobId);
        }
        return;
      }
      const errMsg = e instanceof MomoError ? e.message : e instanceof Error ? e.message : String(e);
      if (canceled) {
        db2.prepare("UPDATE runs SET status='canceled', error='canceled', finished_at=? WHERE id=?").run(Date.now(), runId);
        db2.prepare("UPDATE jobs SET status='canceled', updated_at=? WHERE id=?").run(Date.now(), jobId);
        emitJobUpdate(jobId, { stage: 'canceled' });
      } else {
        const friendly = friendlyError(e);
        db2.prepare('UPDATE runs SET status=?, error=?, finished_at=?, elapsed_ms=? WHERE id=?').run(
          'failed',
          friendly,
          Date.now(),
          Date.now() - startedAt,
          runId
        );
        db2.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run('failed', Date.now(), jobId);
        const job = db2.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
        logEvent('error', `Run 失败：${friendly}`, { jobId, runId });
        emitJobUpdate(jobId, { stage: 'failed', elapsed: Date.now() - startedAt, error: friendly });
        if (job) notifyFail(job.name, friendly);
      }
    } finally {
      this.active.delete(jobId);
      this.aborts.delete(runId);
      emitJobUpdate(jobId);
    }
  }

  /** AI 筹备：特效预演生成（runs.type='effect'）。输入=场图+所选参考图，输出 1K 级预演草图；不参与质检/超分，不改客单状态。 */
  private async processEffect(
    job: JobRow,
    run: RunRow,
    settings: AppSettings,
    ctrl: AbortController,
    info: ActiveInfo,
    stage: (s: string) => void,
    startedAt: number
  ): Promise<void> {
    const db = getDb();
    const runId = run.id;
    const effectId = effectIdOf(run);
    if (!effectId) throw new MomoError('EFFECT_NOT_FOUND', '特效条目不存在');
    const effect = db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(effectId, job.id) as JobEffectRow | undefined;
    if (!effect) throw new MomoError('EFFECT_NOT_FOUND', '特效条目不存在');
    if (!effect.gen_prompt.trim()) throw new MomoError('EFFECT_EMPTY_PROMPT', '该特效的生成描述为空，请先填写再生成');

    db.prepare("UPDATE runs SET status='generating' WHERE id=?").run(runId);
    db.prepare("UPDATE job_effects SET status='generating', error=NULL, run_id=?, updated_at=? WHERE id=?").run(runId, Date.now(), effectId);
    emitPrepUpdate({ jobId: job.id, kind: 'effect', status: 'generating', effectId });

    stage('uploading');
    const maxDim = Math.min(settings.sendMaxDimension, 4096);
    const origAbs = abs(job.original_path);
    const origPart = await imagePartFromFile(origAbs, maxDim, false, true);
    const refIds = parseIdList(effect.ref_material_ids);
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(job.id) as MaterialRow[];
    const selected = materials.filter((m) => refIds.includes(m.id));
    const refNotes: string[] = ['图1=场图（请基于它构图）'];
    const encodeRefs = async (tier: number): Promise<{ images: ImagePart[]; notes: string[] }> => {
      const images: ImagePart[] = [tier >= maxDim ? origPart : await imagePartFromFile(origAbs, tier, false, true)];
      const notes: string[] = ['图1=场图（请基于它构图）'];
      let idx = 2;
      for (const m of selected) {
        const fileAbs = materialFileAbs(m);
        if (!fileAbs) {
          notes.push(`图${idx}=（缺失：${m.display_name}）`);
          idx++;
          continue;
        }
        images.push(await imagePartFromFile(fileAbs, Math.min(tier, 2048), false, true));
        notes.push(`图${idx}=${materialRoleLabel(m.role)}（${m.display_name}）`);
        idx++;
      }
      return { images, notes };
    };
    let parts = await encodeRefs(maxDim);
    let totalBytes = parts.images.reduce((sum, p) => sum + p.base64.length, 0);
    if (totalBytes > TOTAL_SIZE_LIMIT) {
      logLine('warn', `特效预演发送体积 ${Math.round(totalBytes / 1048576)}MB 超限，降档到长边 2048`);
      parts = await encodeRefs(2048);
      totalBytes = parts.images.reduce((sum, p) => sum + p.base64.length, 0);
    }
    refNotes.length = 0;
    refNotes.push(...parts.notes);
    info.message = `发送 ${parts.images.length} 张图（约 ${Math.round(totalBytes / 1048576)}MB）`;

    const prompt = [settings.tplEffectSystem, effect.gen_prompt, `【本次附图】${refNotes.join('；')}`].filter((s) => s && s.trim()).join('\n');
    db.prepare('UPDATE runs SET final_prompt=?, marker_path=NULL WHERE id=?').run(prompt, runId);

    const meta0 = await sharp(origAbs).metadata();
    const aspectRatio = settings.aspectRatio.trim() || closestAspectRatio(meta0.width ?? 1, meta0.height ?? 1);
    const effectSettings = resolveEffectSettings(settings);
    if (!effectSettings.modelId.trim()) throw new MomoError('EFFECT_NO_MODEL', '未配置特效模型 ID（设置页「AI 筹备」）');

    stage('generating');
    const gen = await generateWithFallback({
      images: parts.images,
      prompt,
      signal: ctrl.signal,
      settings: effectSettings,
      aspectRatio,
      mockReturn: origPart,
      context: { jobId: job.id, runId },
      onProgress: (progress) => {
        info.attempt = progress.attempt;
        info.message = progress.message;
        info.retryAt = progress.retryAt;
        stage(progress.stage);
      },
    });

    stage('downloading');
    const ext = /jpe?g/i.test(gen.mime) ? 'jpg' : 'png';
    const runDir = ws('jobs', job.id, '02_runs', runDirName(run.seq));
    fs.mkdirSync(runDir, { recursive: true });
    const resultAbs = path.join(runDir, `result.${ext}`);
    fs.writeFileSync(resultAbs, Buffer.from(gen.base64, 'base64'));

    const elapsed = Date.now() - startedAt;
    db.prepare("UPDATE runs SET result_path=?, result_final_path=?, status='done', elapsed_ms=?, finished_at=? WHERE id=?").run(
      rel(resultAbs),
      rel(resultAbs),
      elapsed,
      Date.now(),
      runId
    );
    db.prepare("UPDATE job_effects SET status='review', image_path=?, error=NULL, updated_at=? WHERE id=?").run(rel(resultAbs), Date.now(), effectId);

    try {
      const meta = {
        runId,
        seq: run.seq,
        type: 'effect',
        effectId,
        title: effect.title,
        model: effectSettings.modelId,
        genPrompt: effect.gen_prompt,
        blendPrompt: effect.blend_prompt,
        refs: refNotes,
        imageCount: parts.images.length,
        finalPrompt: prompt,
        aspectRatio,
        mocked: gen.mocked === true,
        startedAt,
        finishedAt: Date.now(),
        elapsedMs: elapsed,
      };
      fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      /* non fatal */
    }

    logEvent('info', `特效预演完成：${effect.title}（${Math.round(elapsed / 1000)} 秒）`, { jobId: job.id, runId });
    emitPrepUpdate({ jobId: job.id, kind: 'effect', status: 'review', effectId });
    emitJobUpdate(job.id);
  }

  /** 自动面部重修（§4.7.4）：同 Job 内联执行，产物登记为新的 faceRepair Run */
  private async runFaceRepairInline(
    job: JobRow,
    baseRun: RunRow,
    origAbs: string,
    resultAbs: string,
    settings: AppSettings,
    qc: QcResult,
    startedAt: number
  ): Promise<{ runId: string; finalAbs: string } | null> {
    const db = getDb();
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id = ?').get(job.id) as { m: number | null }).m ?? 0) + 1;
    const frId = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO runs (id, job_id, seq, type, status, base_run_id, created_at) VALUES (?, ?, ?, 'faceRepair', 'generating', ?, ?)"
    ).run(frId, job.id, seq, baseRun.id, now);

    try {
      logEvent('info', '身份中分，自动触面部重修', { jobId: job.id, runId: baseRun.id });
      const out = await performFaceRepair({
        origAbs,
        resultAbs,
        signal: this.aborts.get(baseRun.id)?.signal,
      });

      const runDir = ws('jobs', job.id, '02_runs', runDirName(seq));
      fs.mkdirSync(runDir, { recursive: true });
      const rawPath = path.join(runDir, 'result.png');
      const finalPath = path.join(runDir, 'result_final.png');
      fs.writeFileSync(rawPath, Buffer.from(out.rawBase64, 'base64'));
      fs.writeFileSync(finalPath, out.repairedBuf);

      const elapsed = Date.now() - startedAt;
      const cost = settings.pricePerImage;
      db.prepare(
        "UPDATE runs SET status='done', result_path=?, result_final_path=?, cost=?, elapsed_ms=?, finished_at=? WHERE id=?"
      ).run(rel(rawPath), rel(finalPath), cost, elapsed, Date.now(), frId);
      db.prepare('UPDATE jobs SET cost_total = cost_total + ?, updated_at=? WHERE id=?').run(cost, Date.now(), job.id);

      const qcPath = path.join(runDir, 'qc.json');
      const frQc: QcResult = {
        identity: { status: 'skipped', sim: null, reason: null },
        composition: null,
        elements: { confirmed: [] },
        faceRepair: { triggered: false },
      };
      try {
        const recheck = await runIdentityCheck(origAbs, finalPath, { ...settings, qcAutoFaceRepair: false });
        frQc.identity = recheck.identity;
        qc.identity.afterRepair = { sim: recheck.identity.sim, status: recheck.identity.status };
      } catch (e) {
        logLine('warn', `重修后身份复检失败：${String(e)}`);
      }
      fs.writeFileSync(qcPath, JSON.stringify(frQc, null, 2), 'utf8');
      db.prepare('UPDATE runs SET qc_json=? WHERE id=?').run(JSON.stringify(frQc), frId);

      qc.faceRepair = { triggered: true, runId: frId, status: 'done' };
      this.writeFaceRepairRequest(job, baseRun, frId, seq, out, settings, elapsed, cost);
      emitJobUpdate(job.id, { stage: 'review' });
      return { runId: frId, finalAbs: finalPath };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logLine('warn', `面部重修失败，转人工：${msg}`);
      db.prepare("UPDATE runs SET status='failed', error=?, finished_at=? WHERE id=?").run(msg, Date.now(), frId);
      qc.faceRepair = { triggered: true, runId: frId, status: 'failed', error: msg };
      return null;
    }
  }

  private writeFaceRepairRequest(
    job: JobRow,
    baseRun: RunRow,
    frId: string,
    seq: number,
    out: Awaited<ReturnType<typeof performFaceRepair>>,
    settings: AppSettings,
    elapsedMs: number,
    cost: number
  ): void {
    const runDir = ws('jobs', job.id, '02_runs', runDirName(seq));
    const meta = {
      runId: frId,
      type: 'faceRepair',
      baseRunId: baseRun.id,
      model: settings.modelId,
      imageSize: settings.imageSize,
      prompt: settings.tplFaceRepair,
      faceBoxOrig: out.faceBoxOrig,
      faceBoxRes: out.faceBoxRes,
      expandedRes: out.expandedRes,
      mocked: out.mocked,
      cost,
      elapsedMs,
      finishedAt: Date.now(),
    };
    fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  private suggestElements(jobId: string): { label: string; checked: boolean }[] {
    try {
      const db = getDb();
      const regions = db.prepare('SELECT instruction FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(jobId) as { instruction: string }[];
      const labels: string[] = [];
      for (const r of regions) {
        for (const n of extractNouns([r.instruction])) if (!labels.includes(n)) labels.push(n);
      }
      return labels.slice(0, 12).map((label) => ({ label, checked: false }));
    } catch {
      return [];
    }
  }

  private async prepareRun(job: JobRow, run: RunRow, settings: AppSettings): Promise<RunPrep> {
    const db = getDb();
    const templates: AssembleTemplates = {
      tplSystem: settings.tplSystem,
      tplRegion: settings.tplRegion,
      tplGlobal: settings.tplGlobal,
      tplEnding: settings.tplEnding,
      tplBlend: settings.tplBlend,
    };

    if (run.type === 'repair') {
      const rj = (run.request_json ? JSON.parse(run.request_json) : {}) as {
        repairRegions?: { idx: number; color: string; bbox: Bbox; instruction: string }[];
      };
      const repairRegions = rj.repairRegions ?? [];
      const base = run.base_run_id
        ? (db.prepare('SELECT * FROM runs WHERE id=?').get(run.base_run_id) as RunRow | undefined)
        : undefined;
      const baseAbs = abs(base?.result_final_path || base?.result_path || job.original_path);
      const markerPathAbs = ws('jobs', job.id, '01_markers', `markers_v${run.seq}.png`);
      const rendered = await renderMarkers({
        srcPath: baseAbs,
        regions: repairRegions,
        outPath: markerPathAbs,
        sendMaxDimension: settings.sendMaxDimension,
      });
      const locBbox = (b: Bbox) => ({ ...b });
      const lines = repairRegions
        .sort((a, b) => a.idx - b.idx)
        .map((r) =>
          applyTemplate(settings.tplRepair, {
            color: colorName(r.color),
            n: String(r.idx),
            location: locationOf(locBbox(r.bbox), rendered.width, rendered.height),
            repairInstruction: r.instruction,
          })
        );
      const aspectRatio = settings.aspectRatio.trim() || closestAspectRatio(rendered.width, rendered.height);
      const prompt = [canvasConstraint(aspectRatio, false), ...lines, settings.tplEnding].join('\n');
      const fitted = await fitSendParts([{ fileAbs: markerPathAbs, kind: 'marker' }], settings.sendMaxDimension);
      const markerPart = fitted.parts[0];
      const mockPart = await imagePartFromFile(baseAbs, settings.sendMaxDimension);
      return {
        images: [markerPart],
        prompt,
        aspectRatio,
        mockReturn: mockPart,
        markerPath: rel(markerPathAbs),
        requestMeta: {
          type: 'repair',
          baseRunId: run.base_run_id,
          baseImage: base?.result_final_path || base?.result_path,
          repairRegions,
          marker: { width: rendered.width, height: rendered.height, scale: rendered.scale },
          markerSent: { width: markerPart.width ?? 0, height: markerPart.height ?? 0, mime: markerPart.mime, bytes: markerPart.bytes },
        },
      };
    }

    const regions = db
      .prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx')
      .all(job.id) as RegionRow[];
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(job.id) as MaterialRow[];

    // 库素材的融入说明（blend_prompt）→ 按区域的参考图引用注入
    const blendByItemId = new Map<string, string>();
    const itemIds = [...new Set(materials.map((m) => m.library_item_id).filter((v): v is string => !!v))];
    for (const itemId of itemIds) {
      const item = db.prepare('SELECT blend_prompt FROM library_items WHERE id=?').get(itemId) as { blend_prompt: string | null } | undefined;
      if (item?.blend_prompt && item.blend_prompt.trim()) blendByItemId.set(itemId, item.blend_prompt.trim());
    }
    const matById = new Map(materials.map((m) => [m.id, m]));
    const blendNotesOf = (refTokensJson: string): { refNo: number; blendPrompt: string }[] => {
      const tokens = parseTokens(refTokensJson);
      const notes: { refNo: number; blendPrompt: string }[] = [];
      for (const t of tokens) {
        const m = matById.get(t.materialId);
        const blend = m?.library_item_id ? blendByItemId.get(m.library_item_id) : undefined;
        if (blend) notes.push({ refNo: matById.get(t.materialId)?.order_index ?? t.refNo, blendPrompt: blend });
      }
      return notes;
    };

    const origAbs = abs(job.original_path);
    const meta = await sharp(origAbs).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;

    const markerPathAbs = ws('jobs', job.id, '01_markers', `markers_v${run.seq}.png`);
    const rendered = await renderMarkers({
      srcPath: origAbs,
      regions: regions.map((r) => ({ idx: r.idx, color: r.color, bbox: parseBbox(r.bbox_json) })),
      outPath: markerPathAbs,
      sendMaxDimension: settings.sendMaxDimension,
    });

    const assembled = assemblePrompt({
      regions: regions.map((r) => ({
        idx: r.idx,
        color: r.color,
        bbox: parseBbox(r.bbox_json),
        instruction: r.instruction,
        blendNotes: blendNotesOf(r.ref_tokens),
      })),
      globalInstruction: job.global_instruction,
      templates,
      W,
      H,
    });

    const materialRows = materials.map((m) => {
      const fileAbs = (m.source === 'client' || m.source === 'web') && m.file_path ? abs(m.file_path) : libraryFileAbs(m.library_item_id);
      return { m, fileAbs: fileAbs && fs.existsSync(fileAbs) ? fileAbs : null };
    });

    const fitted = await fitSendParts(
      [
        { fileAbs: markerPathAbs, kind: 'marker' },
        ...materialRows.filter((r) => r.fileAbs).map((r) => ({ fileAbs: r.fileAbs!, kind: 'material' as const })),
      ],
      settings.sendMaxDimension
    );
    if (fitted.chosenMaxDim !== settings.sendMaxDimension) {
      logLine('warn', `发送体积超过 ${Math.round(TOTAL_SIZE_LIMIT / 1048576)}MB 上限，已降档发送（长边 ${fitted.chosenMaxDim}px，标记图 ${fitted.markerMime}）`);
    }
    const images: ImagePart[] = fitted.parts;
    const markerSent = fitted.parts[0];

    let partIdx = 1;
    const materialParts = materialRows.map(({ m, fileAbs }) => {
      if (!fileAbs) {
        return { refNo: m.order_index, displayName: m.display_name, source: m.source, libraryItemId: m.library_item_id, file: '', width: 0, height: 0, bytes: 0 };
      }
      const part = fitted.parts[partIdx++]!;
      return {
        refNo: m.order_index,
        displayName: m.display_name,
        role: m.role,
        source: m.source,
        libraryItemId: m.library_item_id,
        blendPrompt: m.library_item_id ? blendByItemId.get(m.library_item_id) ?? '' : '',
        file: rel(fileAbs),
        width: part.width ?? 0,
        height: part.height ?? 0,
        bytes: part.bytes,
      };
    });

    const mockPart = await imagePartFromFile(origAbs, settings.sendMaxDimension);
    const aspectRatio = settings.aspectRatio.trim() || closestAspectRatio(W, H);
    return {
      images,
      prompt: [canvasConstraint(aspectRatio, images.length > 1), assembled.finalPrompt].join('\n'),
      aspectRatio,
      mockReturn: mockPart,
      markerPath: rel(markerPathAbs),
      requestMeta: {
        type: run.type,
        regions: regions.map((r) => ({
          idx: r.idx,
          color: r.color,
          bbox: parseBbox(r.bbox_json),
          instruction: r.instruction,
          refTokens: JSON.parse(r.ref_tokens || '[]'),
          location: locationOf(parseBbox(r.bbox_json), W, H),
        })),
        globalInstruction: job.global_instruction,
        materials: materialParts,
        marker: { width: rendered.width, height: rendered.height, scale: rendered.scale },
        markerSent: { width: markerSent.width ?? 0, height: markerSent.height ?? 0, mime: markerSent.mime, bytes: markerSent.bytes },
      },
    };
  }

  private writeRequestJson(job: JobRow, run: RunRow, prep: RunPrep, startedAt: number, cost: number, error?: string): void {
    try {
      const settings = loadSettings();
      const runDir = ws('jobs', job.id, '02_runs', runDirName(run.seq));
      fs.mkdirSync(runDir, { recursive: true });
      const meta = {
        runId: run.id,
        seq: run.seq,
        type: run.type,
        model: { id: settings.modelId, imageSize: settings.imageSize, aspectRatio: prep.aspectRatio },
        imageCount: prep.images.length,
        finalPrompt: prep.prompt,
        markerPath: prep.markerPath,
        startedAt,
        finishedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        cost,
        error: error ?? null,
        ...prep.requestMeta,
      };
      fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
      logLine('warn', 'request.json 写入失败', String(e));
    }
  }
}

/* ---------- helpers ---------- */

function friendlyError(e: unknown): string {
  if (e instanceof MomoError) {
    switch (e.code) {
      case 'MOMO_API_KEY_INVALID':
        return 'API Key 无效或过期';
      case 'MOMO_SAFETY_BLOCKED':
        return '请求被安全策略拦截';
      case 'MOMO_NO_IMAGE':
        return '模型未返回图像';
      case 'UPSCALE_FAILED':
        return `超分回填失败：${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** 原图宽高（懒回填缓存到 jobs 表，§4.6.8 断言基准） */
async function ensureOriginalSize(job: JobRow, origAbs: string): Promise<{ width: number; height: number }> {
  if (job.orig_width && job.orig_height) return { width: job.orig_width, height: job.orig_height };
  const meta = await sharp(origAbs).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width && height) {
    getDb().prepare('UPDATE jobs SET orig_width=?, orig_height=? WHERE id=?').run(width, height, job.id);
  }
  return { width, height };
}

const opacityCache = new Map<string, Promise<boolean>>();

/** 图片是否完全不透明（alpha 通道存在但全部为 255 时允许转 JPEG，避免白白占用体积预算） */
function isFullyOpaque(fileAbs: string): Promise<boolean> {
  let p = opacityCache.get(fileAbs);
  if (!p) {
    p = sharp(fileAbs)
      .stats()
      .then((st) => {
        const a = st.channels[3];
        return !!a && a.min === 255;
      })
      .catch(() => false);
    opacityCache.set(fileAbs, p);
  }
  return p;
}

async function imagePartFromFile(
  fileAbs: string,
  maxDim: number,
  forcePng = false,
  preferJpeg = false
): Promise<ImagePart & { width?: number; height?: number; bytes: number }> {
  const meta = await sharp(fileAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const long = Math.max(W, H);
  let img = sharp(fileAbs);
  let w = W;
  let h = H;
  if (long > maxDim) {
    const scale = maxDim / long;
    w = Math.max(1, Math.round(W * scale));
    h = Math.max(1, Math.round(H * scale));
    img = img.resize(w, h);
  }
  let usePng = forcePng || (!preferJpeg && (meta.format === 'png' || meta.hasAlpha === true));
  if (!usePng && meta.hasAlpha === true) {
    usePng = !(await isFullyOpaque(fileAbs));
  }
  const buf = usePng ? await img.png().toBuffer() : await img.jpeg({ quality: 90 }).toBuffer();
  return { mime: usePng ? 'image/png' : 'image/jpeg', base64: buf.toString('base64'), width: w, height: h, bytes: buf.length };
}

type EncodedPart = ImagePart & { width?: number; height?: number; bytes: number };

/** 发送体积阶梯适配（§7.1 20MB 上限）：从目标长边向下逐档尝试，标记图优先 PNG、超限再 JPEG，尽量保留分辨率 */
async function fitSendParts(
  sources: { fileAbs: string; kind: 'marker' | 'material' }[],
  maxDim: number
): Promise<{ parts: EncodedPart[]; chosenMaxDim: number; markerMime: string }> {
  const metas = await Promise.all(sources.map((s) => sharp(s.fileAbs).metadata().catch(() => null)));
  const longOf = (i: number) => Math.max(metas[i]?.width ?? 0, metas[i]?.height ?? 0);
  const tiers = [...new Set([maxDim, 5120, 4608, 4096, 3584, 3072, 2560, 2048, 1536].filter((d) => d <= maxDim && d >= 512))].sort((a, b) => b - a);
  if (!tiers.length) tiers.push(maxDim);
  const cache = new Map<string, Promise<EncodedPart>>();
  const encode = (i: number, tier: number, forcePng: boolean, preferJpeg: boolean): Promise<EncodedPart> => {
    const effective = longOf(i) > 0 ? Math.min(tier, longOf(i)) : tier;
    const key = `${i}|${effective}|${forcePng ? 'p' : preferJpeg ? 'j' : 'a'}`;
    let p = cache.get(key);
    if (!p) {
      p = imagePartFromFile(sources[i].fileAbs, effective, forcePng, preferJpeg);
      cache.set(key, p);
    }
    return p;
  };
  let last: { parts: EncodedPart[]; tier: number } | null = null;
  for (const tier of tiers) {
    for (const markerJpeg of [false, true]) {
      const parts = await Promise.all(
        sources.map((s, i) => encode(i, tier, s.kind === 'marker' && !markerJpeg, s.kind === 'material' || markerJpeg))
      );
      last = { parts, tier };
      const total = parts.reduce((sum, p) => sum + p.base64.length, 0);
      if (total <= TOTAL_SIZE_LIMIT) {
        return { parts, chosenMaxDim: tier, markerMime: parts[0]?.mime ?? 'image/png' };
      }
    }
  }
  logLine('warn', `发送体积仍超过 ${Math.round(TOTAL_SIZE_LIMIT / 1048576)}MB 上限，按最小档发送（长边 ${last?.tier ?? maxDim}px）`);
  return { parts: last!.parts, chosenMaxDim: last!.tier, markerMime: last!.parts[0]?.mime ?? 'image/png' };
}

function libraryFileAbs(libraryItemId: string | null): string | null {
  if (!libraryItemId) return null;
  const db = getDb();
  const item = db.prepare('SELECT file_path FROM library_items WHERE id = ?').get(libraryItemId) as { file_path: string } | undefined;
  if (!item) return null;
  return abs(item.file_path);
}

function materialFileAbs(m: MaterialRow): string | null {
  if ((m.source === 'client' || m.source === 'web') && m.file_path) {
    const p = abs(m.file_path);
    return fs.existsSync(p) ? p : null;
  }
  if (m.source === 'library' && m.library_item_id) {
    const p = libraryFileAbs(m.library_item_id);
    return p && fs.existsSync(p) ? p : null;
  }
  return null;
}

function effectIdOf(run: RunRow): string | null {
  try {
    const meta = run.request_json ? (JSON.parse(run.request_json) as { effectId?: string }) : {};
    return meta.effectId ?? null;
  } catch {
    return null;
  }
}

function parseIdList(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const queueManager = new QueueManager();
