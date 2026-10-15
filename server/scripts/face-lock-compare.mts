import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { applyFaceLock } from '../src/qc/faceLock';
import { runIdentityCheck } from '../src/qc';
import { cosineSimilarity, embedFace } from '../src/qc/faces';
import { expandBox } from '../src/qc/faceRepair';
import { abs, ws } from '../src/env';
import { defaultSettings } from '../src/settings';
import type { Bbox } from '../src/types';

interface JobSnapshot {
  job: { id: string; name: string; original_path: string; orig_width: number | null; orig_height: number | null };
}

function usage(): never {
  console.error('用法: npm run face-lock-compare -w server -- <jobId> [runSeq]');
  console.error('示例: npm run face-lock-compare -w server -- 20261015-05 2');
  process.exit(1);
}

function findRun(jobId: string, seq?: number): { seq: number; resultAbs: string } {
  const runsDir = ws('jobs', jobId, '02_runs');
  if (!fs.existsSync(runsDir)) throw new Error(`找不到 ${runsDir}`);
  const seqs = fs
    .readdirSync(runsDir)
    .map((n) => /^run_(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m![1]))
    .sort((a, b) => b - a);
  const pick = (s: number): string | null => {
    const dir = path.join(runsDir, `run_${String(s).padStart(4, '0')}`);
    for (const f of ['result_final.png', 'result.png', 'result.jpg']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  if (seq != null) {
    const p = pick(seq);
    if (!p) throw new Error(`run ${seq} 没有结果文件`);
    return { seq, resultAbs: p };
  }
  for (const s of seqs) {
    const p = pick(s);
    if (p) return { seq: s, resultAbs: p };
  }
  throw new Error('没有找到任何结果文件');
}

async function panel(imgAbs: string, box: Bbox, targetH: number): Promise<{ buf: Buffer; width: number; height: number; box: Bbox }> {
  const meta = await sharp(imgAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const b: Bbox = {
    x1: Math.max(0, Math.floor(box.x1)),
    y1: Math.max(0, Math.floor(box.y1)),
    x2: Math.min(W, Math.ceil(box.x2)),
    y2: Math.min(H, Math.ceil(box.y2)),
  };
  const w = Math.max(8, b.x2 - b.x1);
  const h = Math.max(8, b.y2 - b.y1);
  const outH = Math.min(targetH, h);
  const outW = Math.max(8, Math.round((w / h) * outH));
  const buf = await sharp(imgAbs).extract({ left: b.x1, top: b.y1, width: w, height: h }).resize(outW, outH).png().toBuffer();
  return { buf, width: outW, height: outH, box: b };
}

async function main(): Promise<void> {
  const [jobId, seqArg] = process.argv.slice(2);
  if (!jobId) usage();
  const seq = seqArg != null ? Number(seqArg) : undefined;

  const jobJson = JSON.parse(fs.readFileSync(ws('jobs', jobId, 'job.json'), 'utf8')) as JobSnapshot;
  const origAbs = abs(jobJson.job.original_path);
  if (!fs.existsSync(origAbs)) throw new Error(`原图不存在: ${origAbs}`);
  const { seq: runSeq, resultAbs } = findRun(jobId, seq);
  console.log(`客单 ${jobId}（${jobJson.job.name}）run_${String(runSeq).padStart(4, '0')}`);
  console.log(`原图: ${origAbs}`);
  console.log(`结果: ${resultAbs}`);

  const outDir = ws('faceLock对比', `${jobId}_run${String(runSeq).padStart(4, '0')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const lockedAbs = path.join(outDir, '锁脸后_全图.png');

  const settings = defaultSettings();
  const t0 = Date.now();
  const opt = (name: string, dflt: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const lock = await applyFaceLock({
    origAbs,
    resultAbs,
    outAbs: lockedAbs,
    expandFactor: opt('FXDESK_FL_EXPAND', 1.7),
    featherRatio: opt('FXDESK_FL_FEATHER', 0.42),
    lightStrength: opt('FXDESK_FL_STRENGTH', 0.7),
  });
  if (!lock.applied) {
    console.error(`锁脸未执行：${lock.reason}`);
    process.exit(2);
  }

  const before = await runIdentityCheck(origAbs, resultAbs, settings);
  const simAfter = lock.origKps && lock.placedKps
    ? Number(
        cosineSimilarity(await embedFace(origAbs, lock.origKps), await embedFace(lockedAbs, lock.placedKps)).toFixed(4)
      )
    : (await runIdentityCheck(origAbs, lockedAbs, settings)).identity.sim;
  const simBefore = before.identity.sim;
  const passThreshold = settings.qcFaceLockPass;
  const pass = simAfter != null && simAfter >= passThreshold;

  const beforeCopy = path.join(outDir, '锁脸前_全图.png');
  if (path.resolve(beforeCopy) !== path.resolve(resultAbs)) fs.copyFileSync(resultAbs, beforeCopy);

  const oMeta = await sharp(origAbs).metadata();
  const rMeta = await sharp(resultAbs).metadata();
  const origBox = expandBox(lock.faceBoxOrig!, 1.7, oMeta.width ?? 0, oMeta.height ?? 0);
  const resBox = lock.expandedRes!;
  const targetH = 1100;
  const [p1, p2, p3] = await Promise.all([
    panel(origAbs, origBox, targetH),
    panel(beforeCopy, resBox, targetH),
    panel(lockedAbs, resBox, targetH),
  ]);
  const gap = 18;
  const labelH = 64;
  const panelH = Math.max(p1.height, p2.height, p3.height);
  const totalW = p1.width + p2.width + p3.width + gap * 2;
  const canvasH = labelH + panelH;
  const xs: number[] = [];
  let x = 0;
  for (const p of [p1, p2, p3]) {
    xs.push(x);
    x += p.width + gap;
  }
  const labels = ['1 ORIGINAL (copy source)', '2 BEFORE (model output)', `3 AFTER face lock (sim ${simAfter?.toFixed(3) ?? '—'})`];
  const svgText = labels
    .map((t, i) => {
      const cx = xs[i] + [p1, p2, p3][i].width / 2;
      return `<text x="${cx}" y="42" font-family="Arial, sans-serif" font-size="34" fill="#ffffff" text-anchor="middle">${t}</text>`;
    })
    .join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${canvasH}">${svgText}</svg>`);
  const sheet = await sharp({ create: { width: totalW, height: canvasH, channels: 3, background: { r: 18, g: 18, b: 18 } } })
    .composite([
      ...([p1, p2, p3] as const).map((p, i) => ({ input: p.buf, left: xs[i], top: labelH })),
      { input: svg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(outDir, '脸部对比.png'), sheet);

  const report = {
    jobId,
    jobName: jobJson.job.name,
    runSeq,
    origAbs,
    resultAbs,
    lockedAbs,
    simBefore,
    simAfter,
    passThreshold,
    pass,
    identityStatusBefore: before.identity.status,
    transform: lock.transform,
    guarded: lock.guarded,
    guardReason: lock.guardReason,
    faceBoxOrig: lock.faceBoxOrig,
    faceBoxRes: lock.faceBoxRes,
    expandedRes: lock.expandedRes,
    angleDeg: lock.angleDeg,
    scale: lock.scale,
    alignResidual: lock.alignResidual,
    lightMatch: lock.lightMatch,
    lightGain: lock.gain,
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(outDir, '报告.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`相似度：${simBefore?.toFixed(4) ?? '—'} → ${simAfter?.toFixed(4) ?? '—'}（门槛 ${passThreshold}，${pass ? '通过' : '未达标'}）`);
  console.log(`耗时 ${Math.round((Date.now() - t0) / 1000)} 秒；输出目录：${outDir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
