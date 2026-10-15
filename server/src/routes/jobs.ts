import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { abs, rel, ws } from '../env';
import { hasApiKey, isMockMode, loadSettings } from '../settings';
import { assemblePrompt, paletteColor, parseBbox, parseTokens, regionLine, normalizeHex } from '../prompt';
import type { AssembleTemplates } from '../prompt';
import { renumberRegions } from '../prompt';
import { queueManager } from '../queue';
import { emitJobUpdate, emitLibUpdate } from '../sse';
import { deliverJob } from '../archive';
import { removePath } from '../fsSafe';
import { logEvent } from '../logger';
import { isMaterialRole } from '../prep';
import type { JobRow, MaterialRow, RegionRow, RunRow } from '../types';

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function apiError(statusCode: number, code: string, message: string): Error {
  const e = new Error(message) as Error & { statusCode: number; code: string };
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

async function readMultipart(req: FastifyRequest): Promise<{
  fields: Record<string, string>;
  files: { fieldname: string; filename: string; buf: Buffer; mimetype: string; truncated: boolean }[];
}> {
  const fields: Record<string, string> = {};
  const files: { fieldname: string; filename: string; buf: Buffer; mimetype: string; truncated: boolean }[] = [];
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      files.push({
        fieldname: part.fieldname,
        filename: part.filename ?? 'file',
        buf,
        mimetype: part.mimetype ?? '',
        truncated: part.file.truncated === true,
      });
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, files };
}

function genJobId(): string {
  const db = getDb();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const last = db.prepare(`SELECT id FROM jobs WHERE id LIKE ? ORDER BY id DESC LIMIT 1`).get(`${ymd}-%`) as { id: string } | undefined;
  const seq = last ? parseInt(last.id.split('-')[1], 10) + 1 : 1;
  return `${ymd}-${p(seq)}`;
}

async function importOriginal(jobDirAbs: string, filename: string, buf: Buffer): Promise<{ rawPath: string; normalizedPath: string; width: number; height: number }> {
  const ext = path.extname(filename).toLowerCase() || '.png';
  if (!ALLOWED_EXT.has(ext)) throw apiError(400, 'ORIGINAL_TYPE', '原图仅支持 jpg / png / webp');
  if (buf.length > 50 * 1024 * 1024) throw apiError(400, 'ORIGINAL_TOO_LARGE', '原图不能超过 50MB');
  fs.mkdirSync(path.join(jobDirAbs, 'input'), { recursive: true });
  const rawPath = path.join(jobDirAbs, 'input', `original_original${ext}`);
  fs.writeFileSync(rawPath, buf);
  const normalizedPath = path.join(jobDirAbs, 'input', 'original.png');
  await sharp(buf)
    .rotate()
    .resize({ width: 6144, height: 6144, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(normalizedPath);
  const meta = await sharp(normalizedPath).metadata();
  return { rawPath, normalizedPath, width: meta.width ?? 0, height: meta.height ?? 0 };
}

export function writeJobSnapshot(jobId: string): void {
  try {
    const db = getDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
    if (!job) return;
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(jobId);
    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? ORDER BY idx').all(jobId);
    fs.writeFileSync(
      ws('jobs', jobId, 'job.json'),
      JSON.stringify({ job, materials, regions, snapshotAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    /* non fatal */
  }
}

function jobSummary(job: JobRow) {
  const db = getDb();
  const lastRun = db.prepare("SELECT * FROM runs WHERE job_id=? AND type != 'effect' ORDER BY seq DESC LIMIT 1").get(job.id) as RunRow | undefined;
  const materialCount = (db.prepare('SELECT COUNT(*) AS c FROM job_materials WHERE job_id=?').get(job.id) as { c: number }).c;
  const regionCount = (db.prepare('SELECT COUNT(*) AS c FROM job_regions WHERE job_id=? AND is_repair=0').get(job.id) as { c: number }).c;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    character: job.character,
    brief: job.brief ?? '',
    thumb: job.original_path ? `/api/files/${job.original_path}` : null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    costTotal: job.cost_total,
    materialCount,
    regionCount,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          seq: lastRun.seq,
          type: lastRun.type,
          status: lastRun.status,
          elapsedMs: lastRun.elapsed_ms,
          cost: lastRun.cost,
          error: lastRun.error,
        }
      : null,
  };
}

async function buildPreview(job: JobRow) {
  const db = getDb();
  const settings = loadSettings();
  const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(job.id) as RegionRow[];
  const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(job.id) as MaterialRow[];
  const templates: AssembleTemplates = {
    tplSystem: settings.tplSystem,
    tplRegion: settings.tplRegion,
    tplGlobal: settings.tplGlobal,
    tplEnding: settings.tplEnding,
    tplBlend: settings.tplBlend,
  };
  let W = 0;
  let H = 0;
  try {
    const meta = await sharp(abs(job.original_path)).metadata();
    W = meta.width ?? 0;
    H = meta.height ?? 0;
  } catch {
    /* original missing */
  }
  const blendByItemId = new Map<string, string>();
  const itemIds = [...new Set(materials.map((m) => m.library_item_id).filter((v): v is string => !!v))];
  for (const itemId of itemIds) {
    const item = db.prepare('SELECT blend_prompt FROM library_items WHERE id=?').get(itemId) as { blend_prompt: string | null } | undefined;
    if (item?.blend_prompt && item.blend_prompt.trim()) blendByItemId.set(itemId, item.blend_prompt.trim());
  }
  const matById = new Map(materials.map((m) => [m.id, m]));
  const blendNotesOf = (refTokensJson: string): { refNo: number; blendPrompt: string }[] => {
    const notes: { refNo: number; blendPrompt: string }[] = [];
    for (const t of parseTokens(refTokensJson)) {
      const m = matById.get(t.materialId);
      const blend = m?.library_item_id ? blendByItemId.get(m.library_item_id) : undefined;
      if (blend) notes.push({ refNo: m?.order_index ?? t.refNo, blendPrompt: blend });
    }
    return notes;
  };
  const regionInputs = regions.map((r) => ({
    idx: r.idx,
    color: r.color,
    bbox: parseBbox(r.bbox_json),
    instruction: r.instruction,
    blendNotes: blendNotesOf(r.ref_tokens),
  }));
  const assembled = assemblePrompt({ regions: regionInputs, globalInstruction: job.global_instruction, templates, W, H });
  const regionLines = regions.map((r) => ({
    regionId: r.id,
    line: regionLine(
      { idx: r.idx, color: r.color, bbox: parseBbox(r.bbox_json), instruction: r.instruction, blendNotes: blendNotesOf(r.ref_tokens) },
      templates,
      W,
      H
    ),
  }));
  return { blocks: assembled.blocks, finalPrompt: assembled.finalPrompt, regionLines, width: W, height: H };
}

export function registerJobsRoutes(app: FastifyInstance): void {
  app.get('/api/jobs', async (req) => {
    const db = getDb();
    const qs = req.query as { status?: string };
    let rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[];
    if (qs.status) {
      const wanted = new Set(qs.status.split(',').map((s) => s.trim()).filter(Boolean));
      rows = rows.filter((j) => wanted.has(j.status));
    }
    return { jobs: rows.map(jobSummary) };
  });

  app.post('/api/jobs', async (req) => {
    if (!req.isMultipart()) throw apiError(400, 'MULTIPART_REQUIRED', '请使用 multipart 上传原图');
    const { fields, files } = await readMultipart(req);
    const original = files.find((f) => f.fieldname === 'original');
    if (!original) throw apiError(400, 'NO_ORIGINAL', '缺少原图文件（字段名 original）');
    if (original.truncated) throw apiError(400, 'ORIGINAL_TOO_LARGE', '原图过大（>50MB）');

    const db = getDb();
    const id = genJobId();
    const name = (fields.name ?? '').trim() || id;
    const dir = ws('jobs', id);
    fs.mkdirSync(path.join(dir, 'input'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'materials', 'client'), { recursive: true });
    fs.mkdirSync(path.join(dir, '01_markers'), { recursive: true });
    fs.mkdirSync(path.join(dir, '02_runs'), { recursive: true });

    const imported = await importOriginal(dir, original.filename, original.buf);
    const now = Date.now();
    db.prepare(
      'INSERT INTO jobs (id, name, status, original_path, global_instruction, character, orig_width, orig_height, cost_total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
    ).run(id, name, 'draft', rel(imported.normalizedPath), '', fields.character ?? '', imported.width, imported.height, now, now);
    writeJobSnapshot(id);
    logEvent('info', `新建客单 ${id}（${name}）`, { jobId: id });
    emitJobUpdate(id);
    return { id, name, width: imported.width, height: imported.height };
  });

  app.get('/api/jobs/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(id) as RegionRow[];
    const blendByItemId = new Map<string, string>();
    for (const itemId of [...new Set(materials.map((m) => m.library_item_id).filter((v): v is string => !!v))]) {
      const item = db.prepare('SELECT blend_prompt FROM library_items WHERE id=?').get(itemId) as { blend_prompt: string | null } | undefined;
      if (item?.blend_prompt && item.blend_prompt.trim()) blendByItemId.set(itemId, item.blend_prompt.trim());
    }
    const runs = (db.prepare("SELECT * FROM runs WHERE job_id=? AND type != 'effect' ORDER BY seq").all(id) as RunRow[]).map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type,
      status: r.status,
      baseRunId: r.base_run_id,
      resultUrl: r.result_final_path || r.result_path ? `/api/files/${r.result_final_path || r.result_path}` : null,
      rawUrl: r.result_path ? `/api/files/${r.result_path}` : null,
      markerUrl: r.marker_path ? `/api/files/${r.marker_path}` : null,
      qc: r.qc_json ? JSON.parse(r.qc_json) : null,
      upscale: r.upscale_json ? JSON.parse(r.upscale_json) : null,
      finalPrompt: r.final_prompt,
      cost: r.cost,
      elapsedMs: r.elapsed_ms,
      error: r.error,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    }));
    const preview = await buildPreview(job);
    return {
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
        character: job.character,
        brief: job.brief ?? '',
        globalInstruction: job.global_instruction,
        originalUrl: `/api/files/${job.original_path}`,
        finalRunId: job.final_run_id,
        costTotal: job.cost_total,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
      materials: materials.map((m) => ({
        id: m.id,
        source: m.source,
        libraryItemId: m.library_item_id,
        displayName: m.display_name,
        role: m.role ?? 'general',
        blendPrompt: m.library_item_id ? blendByItemId.get(m.library_item_id) ?? '' : '',
        fileUrl: m.file_path ? `/api/files/${m.file_path}` : libraryFileUrl(m.library_item_id),
        orderIndex: m.order_index,
      })),
      regions: regions.map((r) => ({
        id: r.id,
        idx: r.idx,
        color: r.color,
        bbox: parseBbox(r.bbox_json),
        instruction: r.instruction,
        refTokens: parseTokens(r.ref_tokens),
      })),
      runs,
      preview,
    };
  });

  app.patch('/api/jobs/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as { name?: string; character?: string; global_instruction?: string; brief?: string };
    if (body.name !== undefined) db.prepare('UPDATE jobs SET name=?, updated_at=? WHERE id=?').run(String(body.name), Date.now(), id);
    if (body.character !== undefined) db.prepare('UPDATE jobs SET character=?, updated_at=? WHERE id=?').run(String(body.character), Date.now(), id);
    if (body.brief !== undefined) db.prepare('UPDATE jobs SET brief=?, updated_at=? WHERE id=?').run(String(body.brief).slice(0, 2000), Date.now(), id);
    if (body.global_instruction !== undefined)
      db.prepare('UPDATE jobs SET global_instruction=?, updated_at=? WHERE id=?').run(String(body.global_instruction), Date.now(), id);
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true };
  });

  app.post('/api/jobs/:id/original', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    if (!req.isMultipart()) throw apiError(400, 'MULTIPART_REQUIRED', '请使用 multipart 上传原图');
    const { files } = await readMultipart(req);
    const original = files.find((f) => f.fieldname === 'original');
    if (!original) throw apiError(400, 'NO_ORIGINAL', '缺少原图文件');
    const imported = await importOriginal(ws('jobs', id), original.filename, original.buf);
    db.prepare('UPDATE jobs SET original_path=?, orig_width=?, orig_height=?, updated_at=? WHERE id=?').run(
      rel(imported.normalizedPath),
      imported.width,
      imported.height,
      Date.now(),
      id
    );
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true, width: imported.width, height: imported.height };
  });

  /** 软删除：索引移除 + 文件移入 trash（30 天可手动清空） */
  app.delete('/api/jobs/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const srcDir = ws('jobs', id);
    if (fs.existsSync(srcDir)) {
      const dst = ws('trash', `${id}_${Date.now()}`);
      fs.mkdirSync(ws('trash'), { recursive: true });
      try {
        fs.renameSync(srcDir, dst);
      } catch {
        // Windows 上偶发 EPERM（文件被短暂占用/杀软扫描）→ 复制后删除
        fs.cpSync(srcDir, dst, { recursive: true });
        removePath(srcDir);
      }
    }
    db.prepare('DELETE FROM job_materials WHERE job_id=?').run(id);
    db.prepare('DELETE FROM job_regions WHERE job_id=?').run(id);
    db.prepare('DELETE FROM reviews WHERE run_id IN (SELECT id FROM runs WHERE job_id=?)').run(id);
    db.prepare('DELETE FROM job_effects WHERE job_id=?').run(id);
    db.prepare('DELETE FROM job_preps WHERE job_id=?').run(id);
    db.prepare('DELETE FROM runs WHERE job_id=?').run(id);
    db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    logEvent('info', `客单已删除（移至回收站）：${id}`, { jobId: id });
    return { ok: true };
  });

  /* ---------------- 素材 ---------------- */

  app.post('/api/jobs/:id/materials', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const settings = loadSettings();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM job_materials WHERE job_id=?').get(id) as { c: number }).c;
    const warning = count >= settings.materialSoftLimit ? `v1 建议不超过 ${settings.materialSoftLimit} 张参考图` : null;

    let materialId = randomUUID();
    let order = ((db.prepare('SELECT MAX(order_index) AS m FROM job_materials WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;

    if (req.isMultipart()) {
      const { files, fields } = await readMultipart(req);
      const file = files.find((f) => f.fieldname === 'file');
      if (!file) throw apiError(400, 'NO_FILE', '缺少素材文件（字段名 file）');
      const role = isMaterialRole(fields.role) ? fields.role : 'general';
      const ext = path.extname(file.filename).toLowerCase() || '.png';
      if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.avif'].includes(ext)) throw apiError(400, 'MATERIAL_TYPE', '参考图支持 JPG、PNG、WebP、GIF、TIFF、AVIF');
      if (file.truncated || file.buf.length > 50 * 1024 * 1024) throw apiError(400, 'MATERIAL_TOO_LARGE', '参考图不能超过 50 MB');
      let normalized: Buffer;
      try {
        normalized = await sharp(file.buf).rotate()
          .resize({ width: 6144, height: 6144, fit: 'inside', withoutEnlargement: true })
          .png().toBuffer();
      } catch {
        throw apiError(400, 'MATERIAL_INVALID', '无法读取参考图，请确认文件是有效图片后重试');
      }
      // Allocate after decoding so concurrent uploads receive distinct reference numbers.
      order = ((db.prepare('SELECT MAX(order_index) AS m FROM job_materials WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;
      const safeBase = path.basename(file.filename, ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60) || 'material';
      const filename = `${String(order).padStart(2, '0')}_${safeBase}_${materialId}.png`;
      const dir = ws('jobs', id, 'materials', 'client');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, filename);
      fs.writeFileSync(target, normalized);
      const displayName = (fields.displayName ?? '').trim() || path.basename(file.filename, ext);
      db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(
        materialId,
        id,
        'client',
        displayName,
        rel(target),
        order,
        role
      );
    } else {
      const body = (req.body ?? {}) as { libraryItemId?: string; displayName?: string; role?: string };
      if (!body.libraryItemId) throw apiError(400, 'NO_LIBRARY_ITEM', '缺少 libraryItemId');
      const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(body.libraryItemId) as { id: string; title: string; file_path: string } | undefined;
      if (!item) throw apiError(404, 'LIB_ITEM_NOT_FOUND', '库素材不存在');
      const displayName = (body.displayName ?? '').trim() || item.title || '库素材';
      const role = isMaterialRole(body.role) ? body.role : 'general';
      db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(
        materialId,
        id,
        'library',
        item.id,
        displayName,
        order,
        role
      );
    }

    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { id: materialId, orderIndex: order, warning };
  });

  app.patch('/api/jobs/:id/materials/:mid', async (req) => {
    const db = getDb();
    const { id, mid } = req.params as { id: string; mid: string };
    const body = (req.body ?? {}) as { displayName?: string; role?: string };
    if (body.displayName === undefined && body.role === undefined) throw apiError(400, 'NO_PATCH', '缺少 displayName 或 role');
    const m = db.prepare('SELECT * FROM job_materials WHERE id=? AND job_id=?').get(mid, id) as MaterialRow | undefined;
    if (!m) throw apiError(404, 'MATERIAL_NOT_FOUND', '素材不存在');
    if (body.displayName !== undefined) {
      db.prepare('UPDATE job_materials SET display_name=? WHERE id=?').run(String(body.displayName), mid);
      const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0').all(id) as RegionRow[];
      for (const r of regions) {
        const tokens = parseTokens(r.ref_tokens).map((t) => (t.materialId === mid ? { ...t, name: String(body.displayName) } : t));
        db.prepare('UPDATE job_regions SET ref_tokens=? WHERE id=?').run(JSON.stringify(tokens), r.id);
      }
    }
    if (body.role !== undefined) {
      if (!isMaterialRole(body.role)) throw apiError(400, 'BAD_ROLE', '用途标记无效');
      db.prepare('UPDATE job_materials SET role=? WHERE id=?').run(body.role, mid);
    }
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true };
  });

  app.delete('/api/jobs/:id/materials/:mid', async (req) => {
    const db = getDb();
    const { id, mid } = req.params as { id: string; mid: string };
    const oldMats = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    const target = oldMats.find((m) => m.id === mid);
    if (!target) throw apiError(404, 'MATERIAL_NOT_FOUND', '素材不存在');
    db.prepare('DELETE FROM job_materials WHERE id=?').run(mid);
    const remaining = oldMats.filter((m) => m.id !== mid);
    const newMats: { id: string; order_index: number }[] = [];
    remaining.forEach((m, i) => {
      db.prepare('UPDATE job_materials SET order_index=? WHERE id=?').run(i + 1, m.id);
      newMats.push({ id: m.id, order_index: i + 1 });
    });
    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0').all(id) as RegionRow[];
    const updated = renumberRegions(
      regions.map((r) => ({ id: r.id, instruction: r.instruction, ref_tokens: r.ref_tokens })),
      oldMats.map((m) => ({ id: m.id, order_index: m.order_index })),
      newMats,
      [mid]
    );
    for (const u of updated) {
      db.prepare('UPDATE job_regions SET instruction=?, ref_tokens=? WHERE id=?').run(u.instruction, u.ref_tokens, u.id);
    }
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true, renumbered: true, message: '参考图编号已更新' };
  });

  app.put('/api/jobs/:id/materials/order', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(body.ids)) throw apiError(400, 'NO_IDS', '缺少 ids 数组');
    const oldMats = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    if (oldMats.length !== body.ids.length || !body.ids.every((mid) => oldMats.some((m) => m.id === mid))) {
      throw apiError(400, 'ORDER_MISMATCH', '排序列表与现有素材不一致');
    }
    const newMats: { id: string; order_index: number }[] = [];
    body.ids.forEach((mid, i) => {
      db.prepare('UPDATE job_materials SET order_index=? WHERE id=?').run(i + 1, mid);
      newMats.push({ id: mid, order_index: i + 1 });
    });
    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0').all(id) as RegionRow[];
    const updated = renumberRegions(
      regions.map((r) => ({ id: r.id, instruction: r.instruction, ref_tokens: r.ref_tokens })),
      oldMats.map((m) => ({ id: m.id, order_index: m.order_index })),
      newMats,
      []
    );
    for (const u of updated) {
      db.prepare('UPDATE job_regions SET instruction=?, ref_tokens=? WHERE id=?').run(u.instruction, u.ref_tokens, u.id);
    }
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true, renumbered: true, message: '参考图编号已更新' };
  });

  /* ---------------- 区域 ---------------- */

  app.put('/api/jobs/:id/regions', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as {
      regions?: { id?: string; color?: string; bbox: { x1: number; y1: number; x2: number; y2: number }; instruction: string; refTokens?: { materialId: string; refNo: number; name: string }[] }[];
    };
    if (!Array.isArray(body.regions)) throw apiError(400, 'NO_REGIONS', '缺少 regions 数组');
    const materials = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    const refNoById = new Map(materials.map((m) => [m.id, m.order_index]));

    db.prepare('DELETE FROM job_regions WHERE job_id=? AND is_repair=0').run(id);
    body.regions.forEach((r, i) => {
      const tokens = (r.refTokens ?? [])
        .map((t) => ({ materialId: t.materialId, refNo: refNoById.get(t.materialId) ?? t.refNo, name: t.name }))
        .filter((t) => refNoById.has(t.materialId));
      db.prepare('INSERT INTO job_regions (id, job_id, idx, color, bbox_json, instruction, ref_tokens, is_repair) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(
        r.id ?? randomUUID(),
        id,
        i + 1,
        normalizeHex(r.color ?? paletteColor(i)),
        JSON.stringify(r.bbox),
        String(r.instruction ?? ''),
        JSON.stringify(tokens)
      );
    });
    writeJobSnapshot(id);
    emitJobUpdate(id);
    return { ok: true, count: body.regions.length };
  });

  app.get('/api/jobs/:id/prompt-preview', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    return buildPreview(job);
  });

  /* ---------------- 生成 / 重修 / 交付 / 克隆 ---------------- */

  app.post('/api/jobs/:id/generate', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as { type?: string; baseRunId?: string };

    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(id) as RegionRow[];
    const emptyRegions = regions.filter((r) => !r.instruction.trim()).map((r) => r.id);
    if (emptyRegions.length) throw apiError(400, 'EMPTY_INSTRUCTION', `有 ${emptyRegions.length} 个区域指令为空，请先填写`);
    if (!fs.existsSync(abs(job.original_path))) throw apiError(400, 'NO_ORIGINAL', '原图文件缺失');
    const settings = loadSettings();
    if (!isMockMode(settings) && !hasApiKey(settings)) throw apiError(400, 'NO_API_KEY', 'API Key 未配置，请到设置页填写');

    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;
    const runId = randomUUID();
    const type = body.type === 'rerun' ? 'rerun' : 'initial';
    const baseRunId = type === 'rerun' ? body.baseRunId ?? job.final_run_id ?? null : null;
    db.prepare('INSERT INTO runs (id, job_id, seq, type, status, base_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      runId,
      id,
      seq,
      type,
      'queued',
      baseRunId,
      Date.now()
    );
    db.prepare("UPDATE jobs SET status='queued', updated_at=? WHERE id=?").run(Date.now(), id);
    queueManager.enqueue(id, runId);
    logEvent('info', `入队生成（${type}，Run ${seq}）`, { jobId: id, runId });
    emitJobUpdate(id, { stage: 'queued' });
    return { runId, seq, type };
  });

  app.post('/api/jobs/:id/repair', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as {
      baseRunId?: string;
      regions?: { color?: string; bbox: { x1: number; y1: number; x2: number; y2: number }; instruction: string }[];
    };
    if (!body.baseRunId) throw apiError(400, 'NO_BASE_RUN', '缺少 baseRunId');
    const base = db.prepare('SELECT * FROM runs WHERE id=? AND job_id=?').get(body.baseRunId, id) as RunRow | undefined;
    if (!base) throw apiError(404, 'BASE_RUN_NOT_FOUND', '基准 Run 不存在');
    const repairRegions = (body.regions ?? []).map((r, i) => ({
      idx: i + 1,
      color: normalizeHex(r.color ?? paletteColor(i)),
      bbox: r.bbox,
      instruction: String(r.instruction ?? ''),
    }));
    if (!repairRegions.length) throw apiError(400, 'NO_REPAIR_REGIONS', '请至少圈出 1 个问题区');
    if (repairRegions.some((r) => !r.instruction.trim())) throw apiError(400, 'EMPTY_REPAIR_INSTRUCTION', '问题区修复指令不能为空');
    const settings = loadSettings();
    if (!isMockMode(settings) && !hasApiKey(settings)) throw apiError(400, 'NO_API_KEY', 'API Key 未配置，请到设置页填写');

    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM runs WHERE job_id=?').get(id) as { m: number | null }).m ?? 0) + 1;
    const runId = randomUUID();
    db.prepare('INSERT INTO runs (id, job_id, seq, type, status, base_run_id, request_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      runId,
      id,
      seq,
      'repair',
      'queued',
      body.baseRunId,
      JSON.stringify({ repairRegions }),
      Date.now()
    );
    repairRegions.forEach((r, i) => {
      db.prepare('INSERT INTO job_regions (id, job_id, idx, color, bbox_json, instruction, ref_tokens, is_repair) VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(
        randomUUID(),
        id,
        i + 1,
        r.color,
        JSON.stringify(r.bbox),
        r.instruction,
        '[]'
      );
    });
    db.prepare("UPDATE jobs SET status='queued', updated_at=? WHERE id=?").run(Date.now(), id);
    queueManager.enqueue(id, runId);
    logEvent('info', `入队定点重修（Run ${seq}，问题区 ${repairRegions.length} 个）`, { jobId: id, runId });
    emitJobUpdate(id, { stage: 'queued' });
    return { runId, seq };
  });

  app.post('/api/jobs/:id/deliver', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { runId?: string };
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const runId = body.runId ?? job.final_run_id;
    if (!runId) throw apiError(400, 'NO_RUN', '缺少 runId');
    const result = await deliverJob(id, runId);
    emitJobUpdate(id, { stage: 'delivered' });
    return result;
  });

  app.post('/api/jobs/:id/clone', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const src = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!src) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    const body = (req.body ?? {}) as { name?: string };
    const newId = genJobId();
    const name = (body.name ?? '').trim() || `${src.name} 副本`;
    fs.mkdirSync(ws('jobs', newId, 'input'), { recursive: true });
    fs.mkdirSync(ws('jobs', newId, 'materials', 'client'), { recursive: true });
    fs.mkdirSync(ws('jobs', newId, '01_markers'), { recursive: true });
    fs.mkdirSync(ws('jobs', newId, '02_runs'), { recursive: true });
    const ext = path.extname(src.original_path) || '.png';
    const srcOriginal = abs(src.original_path);
    let newOriginalRel = '';
    if (fs.existsSync(srcOriginal)) {
      const target = ws('jobs', newId, 'input', `original${ext}`);
      fs.copyFileSync(srcOriginal, target);
      newOriginalRel = rel(target);
    }
    const now = Date.now();
    db.prepare(
      'INSERT INTO jobs (id, name, status, original_path, global_instruction, character, brief, cost_total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
    ).run(newId, name, 'draft', newOriginalRel, src.global_instruction, src.character, src.brief ?? '', now, now);

    const oldMats = db.prepare('SELECT * FROM job_materials WHERE job_id=? ORDER BY order_index').all(id) as MaterialRow[];
    const oldToNew = new Map<string, string>();
    for (const m of oldMats) {
      const newMid = randomUUID();
      oldToNew.set(m.id, newMid);
      if (m.source === 'library' && m.library_item_id) {
        const item = db.prepare('SELECT id FROM library_items WHERE id=?').get(m.library_item_id) as { id: string } | undefined;
        if (!item) continue;
        db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(
          newMid,
          newId,
          'library',
          m.library_item_id,
          m.display_name,
          m.order_index,
          m.role ?? 'general'
        );
      } else if ((m.source === 'client' || m.source === 'web') && m.file_path) {
        const srcFile = abs(m.file_path);
        if (!fs.existsSync(srcFile)) continue;
        const base = path.basename(srcFile);
        const target = ws('jobs', newId, 'materials', 'client', base);
        fs.copyFileSync(srcFile, target);
        db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(
          newMid,
          newId,
          m.source,
          m.display_name,
          rel(target),
          m.order_index,
          m.role ?? 'general'
        );
      }
    }

    const regions = db.prepare('SELECT * FROM job_regions WHERE job_id=? AND is_repair=0 ORDER BY idx').all(id) as RegionRow[];
    for (const r of regions) {
      const tokens = parseTokens(r.ref_tokens)
        .map((t) => ({ materialId: oldToNew.get(t.materialId) ?? '', refNo: t.refNo, name: t.name }))
        .filter((t) => t.materialId);
      db.prepare('INSERT INTO job_regions (id, job_id, idx, color, bbox_json, instruction, ref_tokens, is_repair) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(
        randomUUID(),
        newId,
        r.idx,
        r.color,
        r.bbox_json,
        r.instruction,
        JSON.stringify(tokens)
      );
    }
    writeJobSnapshot(newId);
    logEvent('info', `复用配方创建新客单 ${newId}（源自 ${id}）`, { jobId: newId });
    emitJobUpdate(newId);
    emitLibUpdate('job-cloned', undefined);
    return { id: newId, name };
  });

  app.post('/api/trash/empty', async () => {
    const dir = ws('trash');
    let count = 0;
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        removePath(ws('trash', entry));
        count++;
      }
    }
    return { ok: true, removed: count };
  });
}

function libraryFileUrl(libraryItemId: string | null): string | null {
  if (!libraryItemId) return null;
  const db = getDb();
  const item = db.prepare('SELECT file_path FROM library_items WHERE id=?').get(libraryItemId) as { file_path: string } | undefined;
  return item ? `/api/files/${item.file_path}` : null;
}
