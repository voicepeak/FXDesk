import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ensureWorkspaceDirs, PROJECT_ROOT, getWorkspaceRoot } from './env';
import { openDb } from './db';
import { pruneLogs, logLine } from './logger';
import { loadSettings } from './settings';
import { queueManager } from './queue';
import { registerJobsRoutes } from './routes/jobs';
import { registerRunsRoutes } from './routes/runs';
import { registerLibraryRoutes } from './routes/library';
import { registerSettingsRoutes } from './routes/settings';
import { registerFilesRoutes } from './routes/files';
import { registerEventsRoutes } from './routes/events';

const PORT = Number(process.env.PORT ?? 3210);

async function main(): Promise<void> {
  ensureWorkspaceDirs();
  openDb();
  pruneLogs(7);
  loadSettings(true);
  const recovered = queueManager.recoverInterrupted();
  if (recovered) logLine('info', `启动恢复：${recovered} 条中断任务已标记为 failed(interrupted)`);

  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  await app.register(multipart, {
    limits: { fileSize: 60 * 1024 * 1024, files: 8 },
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    const rawCode = e.code;
    const code = rawCode && /^[A-Z_0-9]+$/.test(rawCode) && !rawCode.startsWith('FST_') ? rawCode : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
    if (status >= 500) logLine('error', `${req.method} ${req.url} -> ${e.message}`);
    reply.code(status).send({ error: { code, message: e.message } });
  });

  registerSettingsRoutes(app);
  registerJobsRoutes(app);
  registerRunsRoutes(app);
  registerLibraryRoutes(app);
  registerFilesRoutes(app);
  registerEventsRoutes(app);

  const webDist = path.join(PROJECT_ROOT, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      }
      return reply.sendFile('index.html');
    });
    logLine('info', '已启用静态前端服务（web/dist）');
  }

  await app.listen({ port: PORT, host: '127.0.0.1' });
  logLine('info', `FXDesk server listening on http://127.0.0.1:${PORT}`);
  logLine('info', `workspace: ${getWorkspaceRoot()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
