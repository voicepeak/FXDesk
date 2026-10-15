/**
 * 手动补跑「面部重修 + 锁脸」（用于跳过自动步骤的恢复结果或事后返工）
 * 用法：npm run repair-face -w server -- <jobId> <runSeq>
 * 流程：面部重修（调用模型）→ 身份复检 → 锁脸（原图脸区对齐贴回 + 光照匹配）→ 复检
 * 产物登记为新的 faceRepair Run，并设为该客单最终 Run（状态置为待审核）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, openDb } from '../src/db';
import { abs, rel, ws } from '../src/env';
import { loadSettings } from '../src/settings';
import { logEvent } from '../src/logger';
import { runDirName } from '../src/queue';
import { performFaceRepair } from '../src/qc/faceRepair';
import { applyFaceLock } from '../src/qc/faceLock';
import { runIdentityCheck } from '../src/qc';
import type { JobRow, QcResult, RunRow } from '../src/types';

const [jobId, seqArg] = process.argv.slice(2);
if (!jobId || !seqArg) {
  console.error('用法：npm run repair-face -w server -- <jobId> <runSeq>');
  process.exit(1);
}

openDb();
const db = getDb();
const settings = loadSettings(true);
const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
if (!job) {
  console.error(`客单不存在：${jobId}`);
  process.exit(1);
}
const baseRun = db.prepare('SELECT * FROM runs WHERE job_id=? AND seq=?').get(jobId, Number(seqArg)) as RunRow | undefined;
if (!baseRun) {
  console.error(`没有序号为 ${seqArg} 的 Run`);
  process.exit(1);
}
const baseResultRel = baseRun.result_final_path || baseRun.result_path;
if (baseRun.status !== 'done' || !baseResultRel) {
  console.error(`基准 Run 未完成或没有结果（status=${baseRun.status}）`);
  process.exit(1);
}
const origAbs = abs(job.original_path);
let finalAbs = abs(baseResultRel);

const beforeSim = baseRun.qc_json ? (JSON.parse(baseRun.qc_json) as QcResult).identity?.sim ?? null : null;
console.log(`基准 Run ${baseRun.seq} 身份相似度：${beforeSim ?? '—'}`);

console.log('① 面部重修中（调用模型，约 1-2 分钟）…');
const out = await performFaceRepair({ origAbs, resultAbs: finalAbs });

const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id=?').get(jobId) as { m: number | null }).m ?? 0) + 1;
const frId = randomUUID();
const startedAt = Date.now();
db.prepare("INSERT INTO runs (id, job_id, seq, type, status, base_run_id, created_at) VALUES (?, ?, ?, 'faceRepair', 'generating', ?, ?)").run(
  frId,
  jobId,
  seq,
  baseRun.id,
  startedAt
);

const runDir = ws('jobs', jobId, '02_runs', runDirName(seq));
fs.mkdirSync(runDir, { recursive: true });
const rawPath = path.join(runDir, 'result.png');
const repairedPath = path.join(runDir, 'result_final.png');
fs.writeFileSync(rawPath, Buffer.from(out.rawBase64, 'base64'));
fs.writeFileSync(repairedPath, out.repairedBuf);

const qc: QcResult = {
  identity: { status: 'skipped', sim: null, reason: null, passThreshold: settings.qcIdentityPass, midThreshold: settings.qcIdentityMid },
  composition: null,
  elements: { confirmed: [] },
  faceRepair: { triggered: true, status: 'done' },
};
try {
  const recheck = await runIdentityCheck(origAbs, repairedPath, { ...settings, qcAutoFaceRepair: false });
  qc.identity = recheck.identity;
  console.log(`② 重修后身份相似度：${recheck.identity.sim ?? '—'}（${recheck.identity.status}）`);
} catch (e) {
  console.log('重修后身份复检失败（转人工）：', String(e));
}

let finalPath = repairedPath;
if (settings.qcFaceLock) {
  console.log('③ 锁脸中（原图脸区对齐贴回 + 光照匹配）…');
  const lockedAbs = path.join(runDir, 'result_locked.png');
  try {
    const lock = await applyFaceLock({ origAbs, resultAbs: repairedPath, outAbs: lockedAbs });
    if (lock.applied) {
      const recheck2 = await runIdentityCheck(origAbs, lockedAbs, { ...settings, qcAutoFaceRepair: false });
      const simAfter = recheck2.identity.sim;
      const pass = simAfter != null && simAfter >= settings.qcFaceLockPass;
      qc.identity.afterLock = { sim: simAfter, status: pass ? 'pass' : 'fail' };
      qc.identity.status = pass ? 'pass' : 'fail';
      qc.faceLock = {
        applied: true,
        simBefore: qc.identity.sim,
        simAfter,
        pass,
        passThreshold: settings.qcFaceLockPass,
        runId: frId,
        path: rel(lockedAbs),
        angleDeg: lock.angleDeg,
        scale: lock.scale,
        alignResidual: lock.alignResidual,
        lightMatch: lock.lightMatch,
        elapsedMs: 0,
      };
      finalPath = lockedAbs;
      console.log(`④ 锁脸后身份相似度：${simAfter ?? '—'}（门槛 ${settings.qcFaceLockPass}，${pass ? '通过' : '未达标转人工'}）`);
    } else {
      qc.faceLock = { applied: false, reason: lock.reason };
      console.log(`③ 锁脸未执行（保持重修结果）：${lock.reason ?? '未知原因'}`);
    }
  } catch (e) {
    qc.faceLock = { applied: false, reason: e instanceof Error ? e.message : String(e) };
    console.log('③ 锁脸失败（保持重修结果）：', String(e));
  }
} else {
  console.log('③ 锁脸已关闭（设置项），跳过');
}

fs.writeFileSync(path.join(runDir, 'qc.json'), JSON.stringify(qc, null, 2), 'utf8');
const now = Date.now();
const cost = settings.pricePerImage;
db.prepare(
  "UPDATE runs SET status='done', result_path=?, result_final_path=?, qc_json=?, cost=?, elapsed_ms=?, finished_at=? WHERE id=?"
).run(rel(rawPath), rel(finalPath), JSON.stringify(qc), cost, now - startedAt, now, frId);
db.prepare('UPDATE jobs SET status=?, final_run_id=?, cost_total=cost_total+?, updated_at=? WHERE id=?').run('review', frId, cost, now, jobId);

fs.writeFileSync(
  path.join(runDir, 'request.json'),
  JSON.stringify(
    {
      runId: frId,
      seq,
      type: 'faceRepair',
      baseRunId: baseRun.id,
      model: settings.modelId,
      prompt: settings.tplFaceRepair,
      manual: true,
      faceBoxOrig: out.faceBoxOrig,
      faceBoxRes: out.faceBoxRes,
      expandedRes: out.expandedRes,
      cost,
      finishedAt: now,
    },
    null,
    2
  ),
  'utf8'
);

logEvent('info', `手动补跑面部重修+锁脸完成（基准 Run ${baseRun.seq}，相似度 ${beforeSim ?? '—'} → ${qc.identity.afterLock?.sim ?? qc.identity.sim ?? '—'}）`, { jobId, runId: frId });
console.log(`完成：已登记为 Run ${seq}（faceRepair），客单保持「待审核」。`);
