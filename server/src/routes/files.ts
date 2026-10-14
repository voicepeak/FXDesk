import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { abs, isInsideWorkspace } from '../env';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
};

export function registerFilesRoutes(app: FastifyInstance): void {
  app.get('/api/files/*', async (req, reply) => {
    const relPath = decodeURIComponent(String((req.params as Record<string, string>)['*'] ?? ''));
    const target = abs(relPath);
    if (!isInsideWorkspace(target)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: '路径越界' } });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '文件不存在' } });
    }
    const ext = path.extname(target).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(fs.createReadStream(target));
  });
}
