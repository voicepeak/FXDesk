import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { abs, rel, ws } from '../env';
import { emitLibUpdate } from '../sse';
import { extractPlate } from '../archive';
import { imageStats, KNOWN_COLOR_NAMES } from '../tagging';
import { apiError } from './jobs';
import type { LibraryItemRow } from '../types';

function itemDto(row: LibraryItemRow) {
  let tags: string[] = [];
  let colors: unknown[] = [];
  try {
    tags = JSON.parse(row.tags_json || '[]');
  } catch {
    /* ignore */
  }
  try {
    colors = JSON.parse(row.colors_json || '[]');
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    type: row.type,
    jobId: row.job_id,
    title: row.title,
    fileUrl: `/api/files/${row.file_path}`,
    tags,
    colors,
    source: row.source,
    favorite: !!row.favorite,
    status: row.status,
    width: row.width,
    height: row.height,
    background: row.background,
    createdAt: row.created_at,
  };
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  app.get('/api/library/items', async (req) => {
    const db = getDb();
    const qs = req.query as { q?: string; type?: string; favorite?: string; status?: string; zone?: string };
    let rows = db.prepare('SELECT * FROM library_items ORDER BY created_at DESC').all() as LibraryItemRow[];
    rows = rows.filter((r) => (r.status as string) !== 'deleted');

    if (qs.zone === 'library') rows = rows.filter((r) => r.type === 'plate' || r.type === 'ref');
    else if (qs.zone === 'favorites') rows = rows.filter((r) => r.favorite);
    else if (qs.zone === 'history') rows = rows.filter((r) => r.type === 'history');

    if (qs.type) {
      const types = new Set(qs.type.split(','));
      rows = rows.filter((r) => types.has(r.type));
    }
    if (qs.favorite === '1' || qs.favorite === 'true') rows = rows.filter((r) => r.favorite);
    if (qs.status) rows = rows.filter((r) => r.status === qs.status);

    const q = (qs.q ?? '').trim();
    if (q) {
      const ql = q.toLowerCase();
      const colorChars = KNOWN_COLOR_NAMES.filter((c) => ql.includes(c));
      rows = rows.filter((r) => {
        if (r.title.toLowerCase().includes(ql)) return true;
        if (r.tags_json.toLowerCase().includes(ql)) return true;
        if (colorChars.length) {
          try {
            const colors = JSON.parse(r.colors_json || '[]') as { name?: string; hex?: string }[];
            if (colors.some((c) => c.name && colorChars.some((cc) => String(c.name).includes(cc)))) return true;
          } catch {
            /* ignore */
          }
        }
        return false;
      });
    }

    const items = rows.map(itemDto);
    return {
      available: items.filter((i) => i.type !== 'history'),
      history: items.filter((i) => i.type === 'history'),
      items,
    };
  });

  /** 手动入库（验收步骤：预先手动入库一张“闪电”） */
  app.post('/api/library/items', async (req) => {
    if (!req.isMultipart()) throw apiError(400, 'MULTIPART_REQUIRED', '请使用 multipart 上传');
    const fields: Record<string, string> = {};
    let buf: Buffer | null = null;
    let filename = 'item.png';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        buf = await part.toBuffer();
        filename = part.filename ?? filename;
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!buf) throw apiError(400, 'NO_FILE', '缺少文件');
    const ext = path.extname(filename).toLowerCase() || '.png';
    const type = fields.type === 'plate' ? 'plate' : 'ref';
    const id = randomUUID();
    const targetRel = type === 'plate' ? `library/plates/${id}${ext}` : `library/refs/${id}${ext}`;
    const targetAbs = abs(targetRel);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, buf);

    const stats = await imageStats(targetAbs).catch(() => ({ width: 0, height: 0, background: null, colors: [] }));
    const title = (fields.title ?? '').trim() || path.basename(filename, ext);
    let tags: string[] = [];
    try {
      tags = fields.tags ? JSON.parse(fields.tags) : [];
    } catch {
      tags = String(fields.tags ?? '')
        .split(/[,，、\s]+/)
        .filter(Boolean);
    }
    if (fields.tags && !Array.isArray(tags)) tags = [];
    const db = getDb();
    db.prepare(
      "INSERT INTO library_items (id, type, file_path, job_id, title, tags_json, colors_json, source, favorite, status, width, height, background, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'manual', 0, 'active', ?, ?, ?, ?)"
    ).run(
      id,
      type,
      targetRel,
      title,
      JSON.stringify(tags),
      JSON.stringify(stats.colors),
      stats.width,
      stats.height,
      stats.background === 'photo' ? null : stats.background,
      Date.now()
    );
    emitLibUpdate('manual-import', id);
    const row = db.prepare('SELECT * FROM library_items WHERE id=?').get(id) as LibraryItemRow;
    return itemDto(row);
  });

  app.post('/api/library/items/:id/favorite', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { favorite?: boolean };
    const row = db.prepare('SELECT * FROM library_items WHERE id=?').get(id) as LibraryItemRow | undefined;
    if (!row) throw apiError(404, 'LIB_ITEM_NOT_FOUND', '素材不存在');
    const fav = body.favorite ? 1 : 0;
    // ⭐ 使净版 candidate 升为正式素材（§4.10.6）
    if (fav && row.type === 'plate' && row.status === 'candidate') {
      db.prepare('UPDATE library_items SET favorite=1, status=? WHERE id=?').run('active', id);
    } else {
      db.prepare('UPDATE library_items SET favorite=? WHERE id=?').run(fav, id);
    }
    emitLibUpdate('favorite', id);
    return { ok: true };
  });

  app.patch('/api/library/items/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM library_items WHERE id=?').get(id) as LibraryItemRow | undefined;
    if (!row) throw apiError(404, 'LIB_ITEM_NOT_FOUND', '素材不存在');
    const body = (req.body ?? {}) as { title?: string; tags?: string[]; status?: string };
    if (body.title !== undefined) db.prepare('UPDATE library_items SET title=? WHERE id=?').run(String(body.title), id);
    if (body.tags !== undefined && Array.isArray(body.tags)) db.prepare('UPDATE library_items SET tags_json=? WHERE id=?').run(JSON.stringify(body.tags.map(String)), id);
    if (body.status !== undefined && ['candidate', 'active'].includes(body.status)) db.prepare('UPDATE library_items SET status=? WHERE id=?').run(body.status, id);
    emitLibUpdate('updated', id);
    return { ok: true };
  });

  app.delete('/api/library/items/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM library_items WHERE id=?').get(id) as LibraryItemRow | undefined;
    if (!row) throw apiError(404, 'LIB_ITEM_NOT_FOUND', '素材不存在');
    // 被未完成 Job 引用则禁止删除（§4.10.8）
    const refs = db
      .prepare(
        "SELECT j.id, j.name, j.status FROM job_materials m JOIN jobs j ON j.id = m.job_id WHERE m.library_item_id = ? AND j.status NOT IN ('delivered','canceled','failed')"
      )
      .all(id) as { id: string; name: string; status: string }[];
    if (refs.length) {
      throw apiError(409, 'ITEM_IN_USE', `该素材正被客单引用：${refs.map((r) => r.name).join('、')}，请先处理引用`);
    }
    db.prepare("UPDATE library_items SET status='deleted' WHERE id=?").run(id);
    emitLibUpdate('deleted', id);
    return { ok: true };
  });

  app.post('/api/library/extract-plate', async (req) => {
    const body = (req.body ?? {}) as { jobId?: string; effectDescription?: string };
    if (!body.jobId) throw apiError(400, 'NO_JOB_ID', '缺少 jobId');
    const result = extractPlate(body.jobId, body.effectDescription);
    emitLibUpdate('plate-started', result.itemId);
    return result;
  });
}
