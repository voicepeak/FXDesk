/**
 * 远端结果取回（通用恢复工具）
 * 场景：本地轮询超时/中断，但远端任务其实已完成（如 GrsAI 任务 succeeded）。
 * 用法：npm run adopt-remote -w server -- <jobId> <taskId>
 * 行为：查询远端任务 → 下载结果 → 超分回填至原图分辨率 → 构图/身份质检 → 更新 Run/客单状态为待审核。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getDb, openDb } from '../src/db';
import { abs, rel, ws } from '../src/env';
import { decodeKey, loadSettings } from '../src/settings';
import { logEvent } from '../src/logger';
import { upscaleToOriginal } from '../src/upscale';
import { runIdentityCheck } from '../src/qc';
import { analyzeComposition } from '../src/qc/composition';
import { runDirName } from '../src/queue';
import type { JobRow, QcResult, RunRow } from '../src/types';

const [jobId, taskId] = process.argv.slice(2);
if (!jobId || !taskId) {
  console.error('用法：npm run adopt-remote -w server -- <jobId> <taskId>');
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
const run = db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY seq DESC LIMIT 1").get(jobId) as RunRow | undefined;
if (!run) {
  console.error('该客单没有 Run 记录');
  process.exit(1);
}

const base = settings.baseUrl.replace(/\/+$/, '');
const key = decodeKey(settings.apiKey);

console.log(`查询远端任务 ${taskId} …`);
const resp = await fetch(`${base}/v1/draw/result`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: taskId }),
  signal: AbortSignal.timeout(30000),
});
const envelope = (await resp.json().catch(() => null)) as { code?: number; data?: { status?: string; results?: { url?: string }[]; url?: string; failure_reason?: string; error?: string } } | null;
const data = envelope?.data ?? {};
const status = String(data.status ?? '').toLowerCase();
console.log(`远端状态：${status || '(未知)'}`);
if (status === 'failed') {
  console.error(`远端任务失败：${data.failure_reason || data.error || '未知原因'}（未扣取回操作）`);
  process.exit(1);
}
const url = data.results?.find((x) => x.url)?.url ?? data.url;
if (!url || !['succeeded', 'success', 'completed', 'done'].includes(status)) {
  console.error('远端任务尚未成功或没有结果链接，请稍后再试');
  process.exit(1);
}

console.log('下载结果图…');
const imgResp = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!imgResp.ok) {
  console.error(`下载失败：HTTP ${imgResp.status}`);
  process.exit(1);
}
const buf = Buffer.from(await imgResp.arrayBuffer());
if (buf.length < 1000) {
  console.error('下载内容异常（过小）');
  process.exit(1);
}

const runDir = ws('jobs', jobId, '02_runs', runDirName(run.seq));
fs.mkdirSync(runDir, { recursive: true });
const resultAbs = path.join(runDir, 'result.png');
fs.writeFileSync(resultAbs, buf);
const dims = await sharp(resultAbs).metadata();
console.log(`已保存：${rel(resultAbs)}（${dims.width}x${dims.height}）`);

const origAbs = abs(job.original_path);
const origMeta = await sharp(origAbs).metadata();
const origW = job.orig_width ?? origMeta.width ?? 0;
const origH = job.orig_height ?? origMeta.height ?? 0;

console.log(`超分回填至原图分辨率 ${origW}x${origH}（引擎 ${settings.upscaleEngine}）…`);
const finalAbs = path.join(runDir, 'result_final.png');
const startedAt = Date.now();
const upsc = await upscaleToOriginal({
  srcPath: resultAbs,
  outPath: finalAbs,
  origPath: origAbs,
  origW,
  origH,
  engine: settings.upscaleEngine,
  timeoutSec: settings.upscaleTimeoutSec,
});
console.log(`回填完成：${upsc.from} → ${upsc.to}（${upsc.engine}${upsc.degraded ? '·已降级' : ''}，${Math.round(upsc.elapsedMs / 1000)} 秒）`);

const qc: QcResult = {
  identity: { status: 'skipped', sim: null, reason: null, passThreshold: settings.qcIdentityPass, midThreshold: settings.qcIdentityMid },
  composition: null,
  elements: { confirmed: [] },
  faceRepair: null,
};
try {
  qc.composition = await analyzeComposition(origAbs, finalAbs);
} catch (e) {
  console.log('构图检测失败（跳过）：', String(e));
}
try {
  const idr = await runIdentityCheck(origAbs, finalAbs, { ...settings, qcAutoFaceRepair: false });
  qc.identity = idr.identity;
} catch (e) {
  console.log('身份检测失败（转人工目检）：', String(e));
}
fs.writeFileSync(path.join(runDir, 'qc.json'), JSON.stringify(qc, null, 2), 'utf8');

const now = Date.now();
const cost = settings.pricePerImage;
db.prepare(
  "UPDATE runs SET status='done', result_path=?, result_final_path=?, upscale_json=?, qc_json=?, cost=?, elapsed_ms=?, error=NULL, finished_at=? WHERE id=?"
).run(rel(resultAbs), rel(finalAbs), JSON.stringify(upsc), JSON.stringify(qc), cost, now - startedAt, now, run.id);
db.prepare('UPDATE jobs SET status=?, final_run_id=?, cost_total=cost_total+?, updated_at=? WHERE id=?').run('review', run.id, cost, now, jobId);

const requestPath = path.join(runDir, 'request.json');
if (!fs.existsSync(requestPath)) {
  fs.writeFileSync(
    requestPath,
    JSON.stringify(
      {
        runId: run.id,
        seq: run.seq,
        type: run.type,
        model: { id: settings.modelId, imageSize: settings.imageSize },
        recovered: true,
        remoteTaskId: taskId,
        recoveredAt: now,
        note: '本结果由「远端结果取回」工具恢复：远端任务已完成但本地轮询未收到',
      },
      null,
      2
    ),
    'utf8'
  );
}

logEvent('info', `远端结果取回成功（taskId=${taskId}），已回填并进入待审核`, { jobId, runId: run.id });
console.log('完成：客单已置为「待审核」，可在审核页查看本次恢复的结果。');
