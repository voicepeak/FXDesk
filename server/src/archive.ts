import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { abs, rel, ws } from './env';
import { loadSettings } from './settings';
import { logEvent, logLine } from './logger';
import { parseBbox, parseTokens, applyTemplate } from './prompt';
import { buildArchiveTags, extractNouns, imageStats, type ColorInfo } from './tagging';
import { generateWithFallback } from './momo';
import { emitLibUpdate } from './sse';
import type { JobRow, LibraryItemRow, MaterialRow, RegionRow, RunRow } from './types';

export interface Recipe {
  version: number;
  job: { name: string; character: string };
  materials: { refNo: number; displayName: string; source: string; libraryItemId: string | null }[];
  regions: { idx: number; color: string; bbox: { x1: number; y1: number; x2: number; y2: number }; instruction: string; refTokens: number[] }[];
  globalInstruction: string;
  model: { id: string; imageSize: string };
  finalPrompt: string;
  createdAt: number;
}

export function buildRecipe(jobId: string, deliveredRun?: RunRow | null): Recipe {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
  const mats = db.prepare('SELECT * FROM job_materials WHERE job_id = ? ORDER BY order_index').all(jobId) as MaterialRow[];
  const regions = db.prepare('SELECT * FROM job_regions WHERE job_id = ? AND is_repair = 0 ORDER BY idx').all(jobId) as RegionRow[];
  const settings = loadSettings();
  return {
    version: 1,
    job: { name: job.name, character: job.character },
    materials: mats.map((m) => ({
      refNo: m.order_index,
      displayName: m.display_name,
      source: m.source,
      libraryItemId: m.library_item_id,
    })),
    regions: regions.map((r) => ({
      idx: r.idx,
      color: r.color,
      bbox: parseBbox(r.bbox_json),
      instruction: r.instruction,
      refTokens: parseTokens(r.ref_tokens).map((t) => t.refNo),
    })),
    globalInstruction: job.global_instruction,
    model: { id: settings.modelId, imageSize: settings.imageSize },
    finalPrompt: deliveredRun?.final_prompt ?? '',
    createdAt: Date.now(),
  };
}

export interface DeliverResult {
  finalPath: string;
  libraryItemId: string;
  tags: string[];
}

/** §4.10.3 交付 → 写 03_delivery + recipe + 自动归档（标签=客单名+名词+主色） */
export async function deliverJob(jobId: string, runId: string): Promise<DeliverResult> {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) throw new Error('JOB_NOT_FOUND');
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (!run || run.job_id !== jobId) throw new Error('RUN_NOT_FOUND');
  if (run.status !== 'done') throw new Error('RUN_NOT_DONE');

  const srcRel = run.result_final_path || run.result_path;
  if (!srcRel) throw new Error('RUN_NO_RESULT');
  const srcAbs = abs(srcRel);

  const deliveryDir = ws('jobs', jobId, '03_delivery');
  fs.mkdirSync(deliveryDir, { recursive: true });
  const finalAbs = path.join(deliveryDir, `final_v${run.seq}.png`);
  await sharp(srcAbs).png().toFile(finalAbs);

  const recipe = buildRecipe(jobId, run);
  fs.writeFileSync(ws('jobs', jobId, 'recipe.json'), JSON.stringify(recipe, null, 2), 'utf8');

  // 归档到素材库历史成果
  const histDir = ws('library', 'history', jobId);
  fs.mkdirSync(histDir, { recursive: true });
  const histFinal = path.join(histDir, 'final.png');
  fs.copyFileSync(finalAbs, histFinal);
  fs.writeFileSync(path.join(histDir, 'recipe.json'), JSON.stringify(recipe, null, 2), 'utf8');

  const stats = await imageStats(histFinal).catch(() => ({ width: 0, height: 0, background: 'photo' as const, colors: [] as ColorInfo[] }));
  const regionInstructions = (db.prepare('SELECT instruction FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(jobId) as { instruction: string }[]).map(
    (r) => r.instruction
  );
  const tags = buildArchiveTags({
    jobName: job.name,
    character: job.character,
    regionInstructions,
    globalInstruction: job.global_instruction,
    colors: stats.colors,
  });

  const existing = db.prepare("SELECT * FROM library_items WHERE job_id = ? AND type = 'history'").get(jobId) as LibraryItemRow | undefined;
  let itemId: string;
  if (existing) {
    itemId = existing.id;
    db.prepare('UPDATE library_items SET file_path=?, title=?, tags_json=?, colors_json=?, width=?, height=?, background=? WHERE id=?').run(
      rel(histFinal),
      job.name,
      JSON.stringify(tags),
      JSON.stringify(stats.colors),
      stats.width,
      stats.height,
      'photo',
      itemId
    );
  } else {
    itemId = randomUUID();
    db.prepare(
      "INSERT INTO library_items (id, type, file_path, job_id, title, tags_json, colors_json, source, favorite, status, width, height, background, created_at) VALUES (?, 'history', ?, ?, ?, ?, ?, 'ai', 0, 'active', ?, ?, 'photo', ?)"
    ).run(itemId, rel(histFinal), jobId, job.name, JSON.stringify(tags), JSON.stringify(stats.colors), stats.width, stats.height, Date.now());
  }

  db.prepare("UPDATE jobs SET status='delivered', final_run_id=?, updated_at=? WHERE id=?").run(runId, Date.now(), jobId);
  db.prepare('INSERT INTO reviews (id, run_id, action, note, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), runId, 'approve', '', Date.now());

  logEvent('info', `客单已交付，自动归档（标签：${tags.join('、')}）`, { jobId, runId });
  emitLibUpdate('archived', itemId);
  return { finalPath: rel(finalAbs), libraryItemId: itemId, tags };
}

/** §4.10.6 惰性净版提取：输入=成片，A.7 模板 → 黑底净版 candidate */
export function extractPlate(jobId: string, effectDescription?: string): { itemId: string; description: string } {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) throw new Error('JOB_NOT_FOUND');

  const finalRun = job.final_run_id ? (db.prepare('SELECT * FROM runs WHERE id = ?').get(job.final_run_id) as RunRow | undefined) : undefined;
  const srcRel = finalRun?.result_final_path || finalRun?.result_path || latestDoneResultRel(jobId);
  if (!srcRel) throw new Error('NO_RESULT');
  const srcAbs = abs(srcRel);

  const regionInstructions = (db.prepare('SELECT instruction FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(jobId) as { instruction: string }[]).map(
    (r) => r.instruction
  );
  const description = (effectDescription && effectDescription.trim()) || extractNouns(regionInstructions).slice(0, 3).join('、') || '画面特效';

  const itemId = randomUUID();
  const itemIdSafe = itemId;
  const plateRel = `library/plates/${itemIdSafe}.png`;
  const plateAbs = abs(plateRel);
  fs.mkdirSync(path.dirname(plateAbs), { recursive: true });

  const settings = loadSettings();
  const tags = [...new Set([...extractNouns([description]), '净版'])];

  // 占位黑图，稍后覆盖
  void sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toFile(plateAbs).catch(() => undefined);

  db.prepare(
    "INSERT INTO library_items (id, type, file_path, job_id, title, tags_json, colors_json, source, favorite, status, width, height, background, created_at) VALUES (?, 'plate', ?, ?, ?, ?, '[]', 'ai', 0, 'candidate', NULL, NULL, 'black', ?)"
  ).run(itemIdSafe, plateRel, jobId, description, JSON.stringify(tags), Date.now());

  void (async () => {
    try {
      const prompt = applyTemplate(settings.tplPlate, { effectDescription: description });
      const mockBlack = await mockPlateImage();
      const gen = await generateWithFallback({
        images: [{ mime: 'image/png', base64: (await sharp(srcAbs).resize({ width: 2048, height: 2048, fit: 'inside' }).png().toBuffer()).toString('base64') }],
        prompt,
        settings,
        mockReturn: { mime: 'image/png', base64: mockBlack.toString('base64') },
      });
      const buf = Buffer.from(gen.base64, 'base64');
      await sharp(buf).png().toFile(plateAbs);
      const stats = await imageStats(plateAbs).catch(() => ({ width: 0, height: 0, background: 'black' as const, colors: [] as ColorInfo[] }));
      db.prepare('UPDATE library_items SET width=?, height=?, background=?, colors_json=? WHERE id=?').run(
        stats.width,
        stats.height,
        stats.background === 'photo' ? 'black' : stats.background,
        JSON.stringify(stats.colors),
        itemIdSafe
      );
      logEvent('info', `净版提取完成：${description}`, { jobId });
      emitLibUpdate('plate-ready', itemIdSafe);
    } catch (e) {
      logLine('warn', `净版提取失败：${String(e)}`);
      db.prepare("UPDATE library_items SET status='candidate', title=? WHERE id=?").run(`${description}（提取失败）`, itemIdSafe);
      emitLibUpdate('plate-failed', itemIdSafe);
    }
  })();

  return { itemId: itemIdSafe, description };
}

function latestDoneResultRel(jobId: string): string | null {
  const db = getDb();
  const run = db.prepare("SELECT * FROM runs WHERE job_id = ? AND status = 'done' ORDER BY seq DESC LIMIT 1").get(jobId) as RunRow | undefined;
  return run?.result_final_path || run?.result_path || null;
}

async function mockPlateImage(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect width="1024" height="1024" fill="#000000"/>
    <polygon points="560,120 440,520 540,520 400,900 660,460 560,460 690,120" fill="#FDD835" opacity="0.9"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
