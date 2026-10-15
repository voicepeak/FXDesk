import type { FastifyInstance } from 'fastify';
import { encodeKey, isMockMode, loadSettings, publicSettings, updateSettings } from '../settings';
import { getBalance, testConnection, MomoError } from '../momo';
import { queueManager } from '../queue';

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', async () => {
    return publicSettings(loadSettings());
  });

  app.put('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = updateSettings(body);
    if (!r.ok) {
      return reply.code(400).send({ error: { code: 'SETTINGS_INVALID', message: r.error ?? '设置校验失败' } });
    }
    queueManager.applyConcurrency();
    return publicSettings(loadSettings());
  });

  app.post('/api/settings/test-connection', async (req) => {
    const body = (req.body ?? {}) as { apiKey?: string; baseUrl?: string; provider?: string };
    const s = { ...loadSettings() };
    if (body.baseUrl) s.baseUrl = body.baseUrl;
    if (body.provider === 'auto' || body.provider === 'momo' || body.provider === 'grsai') s.provider = body.provider;
    if (body.apiKey && body.apiKey !== 'obf:***') s.apiKey = encodeKey(body.apiKey);
    if (!s.apiKey && !isMockMode(s)) {
      return { ok: false, error: '请先填写 API Key' };
    }
    return testConnection(s);
  });

  app.get('/api/balance', async (_req, reply) => {
    try {
      const b = await getBalance();
      return b;
    } catch (e) {
      const msg = e instanceof MomoError ? e.message : e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: { code: 'BALANCE_FAILED', message: msg } });
    }
  });
}
