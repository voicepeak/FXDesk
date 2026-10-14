import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-selection-upload-'));
process.env.FXDESK_WORKSPACE = tmp;
import { getDb, openDb } from '../src/db';
import { registerJobsRoutes } from '../src/routes/jobs';

const app = Fastify();
function upload(buf: Buffer, filename: string, contentType = 'image/png') {
  const boundary = 'fxdesk-test-boundary';
  return app.inject({ method: 'POST', url: '/api/jobs/job/materials', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) });
}
beforeAll(async () => {
  openDb();
  fs.mkdirSync(path.join(tmp, 'jobs/job'), { recursive: true });
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#777' } }).png().toFile(path.join(tmp, 'original.png'));
  getDb().prepare("INSERT INTO jobs (id,name,status,original_path,created_at,updated_at) VALUES ('job','job','draft','original.png',0,0)").run();
  await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024 } });
  registerJobsRoutes(app);
});
afterAll(async () => {
  await app.close(); getDb().close();
  const resolved = path.resolve(tmp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('fxdesk-selection-upload-')) fs.rmSync(resolved, { recursive: true, force: true });
});

describe('选区保存和参考图上传', () => {
  it('保存后读取椭圆、多边形、套索和旧矩形选区', async () => {
    const regions = ['rect', 'ellipse', 'polygon', 'lasso'].map((shape, i) => ({ id: `r${i}`, color: '#E53935', instruction: '修改', refTokens: [], bbox: { x1: 10, y1: 10, x2: 80, y2: 80, shape, ...(i >= 2 ? { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] } : {}) } }));
    const saved = await app.inject({ method: 'PUT', url: '/api/jobs/job/regions', payload: { regions } });
    expect(saved.statusCode).toBe(200);
    const loaded = await app.inject({ method: 'GET', url: '/api/jobs/job' });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().regions.map((r: { bbox: unknown }) => r.bbox)).toEqual(regions.map((r) => r.bbox));
  });

  it('GIF 和 TIFF 参考图转为浏览器、生成服务可读取的 PNG', async () => {
    for (const format of ['gif', 'tiff'] as const) {
      const buf = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#123456' } }).toFormat(format).toBuffer();
      const response = await upload(buf, `参考 ${format}.${format}`, `image/${format}`);
      expect(response.statusCode).toBe(200);
      const row = getDb().prepare('SELECT file_path FROM job_materials WHERE id=?').get(response.json().id) as { file_path: string };
      const meta = await sharp(path.join(tmp, row.file_path)).metadata();
      expect(meta.format).toBe('png'); expect(meta.width).toBe(40); expect(meta.height).toBe(30);
    }
  });

  it('并发上传同名图片仍分配唯一编号和独立文件', async () => {
    const buf = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#123456' } }).png().toBuffer();
    const responses = await Promise.all([upload(buf, '同名.png'), upload(buf, '同名.png')]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(new Set(responses.map((r) => r.json().orderIndex)).size).toBe(2);
    const rows = getDb().prepare('SELECT file_path FROM job_materials').all() as { file_path: string }[];
    expect(new Set(rows.map((r) => r.file_path)).size).toBe(rows.length);
  });

  it('损坏图片和不支持的文件返回明确错误，不添加素材', async () => {
    const count = () => (getDb().prepare('SELECT COUNT(*) AS c FROM job_materials').get() as { c: number }).c;
    const before = count();
    const broken = await upload(Buffer.from('not an image'), 'broken.png');
    expect(broken.statusCode).toBe(400); expect(broken.json().message).toContain('有效图片');
    const unsupported = await upload(Buffer.from('document'), 'document.pdf', 'application/pdf');
    expect(unsupported.statusCode).toBe(400); expect(unsupported.json().message).toContain('参考图支持');
    expect(count()).toBe(before);
  });
});
