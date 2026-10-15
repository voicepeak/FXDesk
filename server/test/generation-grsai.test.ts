import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateViaGrsai, generateWithFallback, getBalance, testConnection } from '../src/momo';
import { defaultSettings, type AppSettings } from '../src/settings';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-grsai-'));
process.env.FXDESK_WORKSPACE = tmp;
process.env.FXDESK_GRSAI_POLL_MS = '30';

const PNG = Buffer.from('fake-png-bytes-for-grsai-test');
const KEY = 'sk-test';
const TEST_TASK_ID = '00000000-0000-0000-0000-000000000000';

type Mode = 'running-then-ok' | 'running-forever' | 'moderation' | 'remote-error';

let server: http.Server;
let baseUrl: string;
let mode: Mode = 'running-then-ok';
let submits: Record<string, unknown>[] = [];
let polls = 0;
let resultCallsToSucceed = 2;
let recoverFails = false;

const readBody = (req: http.IncomingMessage, cb: (body: Record<string, unknown>) => void) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      cb(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      cb({});
    }
  });
};

const send = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', Connection: 'close' });
      res.end(PNG);
      return;
    }
    readBody(req, (body) => {
      const authed = req.headers.authorization === `Bearer ${KEY}`;
      if (req.method === 'POST' && req.url === '/v1/draw/nano-banana') {
        submits.push(body);
        if (!authed) return send(res, { code: -1, data: null, msg: 'apikey error' });
        return send(res, { code: 0, msg: 'success', data: { id: 'task-1' } });
      }
      if (req.method === 'POST' && req.url === '/v1/draw/result') {
        if (!authed) return send(res, { code: -1, data: null, msg: 'apikey error' });
        if (body.id === TEST_TASK_ID) return send(res, { code: -22, data: null, msg: '任务不存在' });
        // 恢复查询（带标记头）：默认返回已完成结果，用于验证「超时后最后一次取回」
        if (req.headers['x-fxdesk-recover']) {
          if (recoverFails) return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'running', progress: 30 } });
          return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'succeeded', progress: 100, results: [{ url: `${baseUrl}/img.png` }] } });
        }
        polls++;
        if (mode === 'moderation') {
          return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'failed', failure_reason: 'output_moderation', error: 'violence detected' } });
        }
        if (mode === 'remote-error') {
          return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'failed', failure_reason: 'error', error: 'upstream busy' } });
        }
        if (mode === 'running-forever' || polls < resultCallsToSucceed) {
          return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'running', progress: 30 } });
        }
        return send(res, { code: 0, msg: 'success', data: { id: 'task-1', status: 'succeeded', progress: 100, results: [{ url: `${baseUrl}/img.png` }] } });
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server.closeAllConnections();
  mode = 'running-then-ok';
  submits = [];
  polls = 0;
  resultCallsToSucceed = 2;
  recoverFails = false;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FXDESK_GRSAI_POLL_MS;
});

const options = (patch: Partial<AppSettings> = {}) => ({
  images: [{ mime: 'image/png', base64: 'aW1hZ2U=' }],
  prompt: '测试提示词',
  aspectRatio: '3:4',
  settings: {
    ...defaultSettings(),
    provider: 'grsai' as const,
    apiKey: KEY,
    baseUrl,
    modelId: 'nano-banana-2.1',
    imageSize: '4K' as const,
    aspectRatio: '',
    mockApi: false,
    runTimeoutSec: 5,
    ...patch,
  },
});

describe('GrsAI 生成（仅访问本地假服务）', () => {
  it('提交载荷完整（裸 base64 urls / webHook -1 / imageSize），轮询成功后下载结果', async () => {
    const r = await generateViaGrsai(options());
    expect(r.mime).toBe('image/png');
    expect(r.base64).toBe(PNG.toString('base64'));
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      model: 'nano-banana-2.1',
      prompt: '测试提示词',
      urls: ['aW1hZ2U='],
      aspectRatio: '3:4',
      webHook: '-1',
      imageSize: '4K',
    });
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('nano-banana-fast 不发送 imageSize', async () => {
    await generateViaGrsai(options({ modelId: 'nano-banana-fast' }));
    expect(submits[0].imageSize).toBeUndefined();
  });

  it('Key 无效（HTTP 200 + apikey error）立即失败且不重复提交', async () => {
    await expect(generateViaGrsai(options({ apiKey: 'bad-key' }))).rejects.toMatchObject({ code: 'MOMO_API_KEY_INVALID' });
    expect(submits).toHaveLength(1);
  });

  it('远端安全审核失败映射为安全拦截', async () => {
    mode = 'moderation';
    await expect(generateViaGrsai(options())).rejects.toMatchObject({ code: 'MOMO_SAFETY_BLOCKED' });
    expect(submits).toHaveLength(1);
  });

  it('远端任务失败携带原因，不自动重提', async () => {
    mode = 'remote-error';
    await expect(generateViaGrsai(options())).rejects.toMatchObject({ code: 'MOMO_REMOTE_FAILED', message: expect.stringContaining('upstream busy') });
    expect(submits).toHaveLength(1);
  });

  it('超时后最后一次查询取回远端已完成的结果（不白丢已出图）', async () => {
    mode = 'running-forever';
    const r = await generateViaGrsai(options({ runTimeoutSec: 1 }));
    expect(r.base64).toBe(PNG.toString('base64'));
    expect(submits).toHaveLength(1);
  });

  it('取回查询也拿不到时，超时提示远端任务 ID，且不重复提交', async () => {
    mode = 'running-forever';
    recoverFails = true;
    await expect(generateViaGrsai(options({ runTimeoutSec: 1 }))).rejects.toMatchObject({ code: 'MOMO_TIMEOUT', message: expect.stringContaining('task-1') });
    expect(submits).toHaveLength(1);
  });

  it('等待中取消，立即结束且不再次提交', async () => {
    mode = 'running-forever';
    const ctrl = new AbortController();
    await expect(
      generateViaGrsai({
        ...options(),
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.stage === 'generating' && /生成中/.test(p.message)) ctrl.abort();
        },
      })
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(submits).toHaveLength(1);
  });

  it('generateWithFallback 按服务商路由到 GrsAI', async () => {
    const r = await generateWithFallback(options());
    expect(r.base64).toBe(PNG.toString('base64'));
  });

  it('testConnection：无效 Key 报错；任务不存在（-22）视为 Key 有效', async () => {
    const bad = await testConnection({ ...defaultSettings(), provider: 'grsai', apiKey: 'bad-key', baseUrl });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('API Key 无效或过期');
    const good = await testConnection({ ...defaultSettings(), provider: 'grsai', apiKey: KEY, baseUrl });
    expect(good.ok).toBe(true);
    expect(good.message).toContain('GrsAI');
  });

  it('GrsAI 余额查询返回明确的“不支持”提示', async () => {
    await expect(getBalance({ ...defaultSettings(), provider: 'grsai', baseUrl })).rejects.toMatchObject({ code: 'MOMO_BALANCE_UNSUPPORTED' });
  });
});
