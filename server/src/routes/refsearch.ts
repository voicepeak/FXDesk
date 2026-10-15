import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { rel, ws } from '../env';
import { loadSettings } from '../settings';
import { emitJobUpdate } from '../sse';
import { logEvent } from '../logger';
import { apiError, writeJobSnapshot } from './jobs';
import type { JobRow } from '../types';
import { isMaterialRole } from '../prep';
import { fetchXhsImage, fetchXhsThumb, isAllowedImageUrl, startXhsLogin, xhsBrowserInstalled, xhsLoginInfo, xhsProfileDir, xhsSearch } from '../refsearch/xhs';

export function registerRefSearchRoutes(app: FastifyInstance): void {
  app.get('/api/refsearch/status', async () => {
    const { state, error } = xhsLoginInfo();
    return {
      source: 'xhs',
      browserInstalled: xhsBrowserInstalled(),
      profileExists: fs.existsSync(xhsProfileDir()),
      loginState: state,
      loginError: error,
    };
  });

  app.post('/api/refsearch/login', async () => {
    if (!xhsBrowserInstalled()) {
      throw apiError(500, 'BROWSER_MISSING', '浏览器组件未安装，请先运行 npx playwright install chromium');
    }
    return startXhsLogin();
  });

  app.post('/api/refsearch/search', async (req) => {
    const body = (req.body ?? {}) as { keyword?: string; limit?: number };
    const keyword = String(body.keyword ?? '').trim().slice(0, 60);
    const limit = Math.max(6, Math.min(48, Number(body.limit) || 24));
    const items = await xhsSearch(keyword, limit);
    logEvent('info', `参考搜索：小红书「${keyword}」返回 ${items.length} 条`);
    return { source: 'xhs', items };
  });

  app.get('/api/refsearch/thumb', async (req, reply) => {
    const u = String((req.query as Record<string, unknown>).u ?? '');
    const { buf, contentType } = await fetchXhsThumb(u);
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(buf);
  });

  app.post('/api/refsearch/import', async (req) => {
    const db = getDb();
    const body = (req.body ?? {}) as { jobId?: string; imageUrl?: string; title?: string; role?: string };
    const jobId = String(body.jobId ?? '');
    const imageUrl = String(body.imageUrl ?? '');
    const role = isMaterialRole(body.role) ? body.role : 'general';
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
    if (!job) throw apiError(404, 'JOB_NOT_FOUND', '客单不存在');
    if (!isAllowedImageUrl(imageUrl)) throw apiError(400, 'BAD_IMAGE_URL', '仅支持小红书图片链接');

    const settings = loadSettings();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM job_materials WHERE job_id=?').get(jobId) as { c: number }).c;
    const warning = count >= settings.materialSoftLimit ? `v1 建议不超过 ${settings.materialSoftLimit} 张参考图` : null;

    const raw = await fetchXhsImage(imageUrl);
    let normalized: Buffer;
    try {
      normalized = await sharp(raw)
        .rotate()
        .resize({ width: 6144, height: 6144, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      throw apiError(400, 'IMAGE_INVALID', '该图片无法解码，换一张再试');
    }

    const materialId = randomUUID();
    const order =
      ((db.prepare('SELECT MAX(order_index) AS m FROM job_materials WHERE job_id=?').get(jobId) as { m: number | null }).m ?? 0) + 1;
    const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
    const displayName = (title || '小红书参考').slice(0, 40);
    const safeBase = displayName.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40) || '小红书参考';
    const dir = ws('jobs', jobId, 'materials', 'client');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${String(order).padStart(2, '0')}_${safeBase}_${materialId}.png`;
    const target = path.join(dir, filename);
    fs.writeFileSync(target, normalized);

    db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(
      materialId,
      jobId,
      'web',
      displayName,
      rel(target),
      order,
      role
    );
    writeJobSnapshot(jobId);
    emitJobUpdate(jobId);
    logEvent('info', `参考搜索：已加入参考图「${displayName}」（客单 ${jobId} 参考图 ${order}）`, { jobId });
    return { id: materialId, orderIndex: order, displayName, warning };
  });
}
