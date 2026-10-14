import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateContent, type GenerationProgress } from '../src/momo';
import { defaultSettings, type AppSettings } from '../src/settings';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-network-'));
process.env.FXDESK_WORKSPACE = tmp;
let server: http.Server;
let baseUrl: string;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let calls = 0;
const image = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] };
const options = (patch: Partial<AppSettings> = {}) => ({ images: [], prompt: 'test', settings: { ...defaultSettings(), apiKey: 'test-only-key', baseUrl, mockApi: false, runTimeoutSec: 5, ...patch } });

beforeAll(async () => {
  server = http.createServer((req, res) => { calls++; req.resume(); handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { server.closeAllConnections(); calls = 0; });
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('生成请求等待与避免重复提交（仅访问本地假服务）', () => {
  it('发送本次生成的主图比例，并保留原有 4K 设置', async () => {
    let received: any;
    handler = (req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { received = JSON.parse(body); res.end(JSON.stringify(image)); });
    };
    await generateContent({ ...options({ aspectRatio: '16:9', imageSize: '4K' }), aspectRatio: '3:4' });
    expect(received.generationConfig.imageConfig).toEqual({ imageSize: '4K', aspectRatio: '3:4' });
    expect(calls).toBe(1);
  });

  it('慢响应在等待预算内只提交一次，正确读取图片', async () => {
    handler = (_req, res) => { setTimeout(() => { res.setHeader('x-request-id', 'remote-test'); res.end(JSON.stringify(image)); }, 150); };
    expect((await generateContent(options())).base64).toBe('aW1hZ2U=');
    expect(calls).toBe(1);
  });
  it('远端已接收后断开连接，不自动重新提交', async () => {
    handler = (req) => { req.on('end', () => req.socket.destroy()); };
    await expect(generateContent(options())).rejects.toMatchObject({ code: 'MOMO_NETWORK', retriable: false });
    expect(calls).toBe(1);
  });
  it('503 结果不明确，不自动重新提交', async () => {
    handler = (_req, res) => { res.writeHead(503); res.end('upstream disconnected'); };
    await expect(generateContent(options())).rejects.toMatchObject({ code: 'MOMO_HTTP_5XX', retriable: false });
    expect(calls).toBe(1);
  });
  it('返回无效 JSON 不自动重新提交，并记录明确错误', async () => {
    handler = (_req, res) => res.end('<html>bad gateway</html>');
    await expect(generateContent(options())).rejects.toMatchObject({ code: 'MOMO_RESPONSE_INVALID', retriable: false });
    expect(calls).toBe(1);
  });
  it('等待超时后结束本地等待，提示核对远端记录，不重发', async () => {
    handler = () => {};
    await expect(generateContent(options({ runTimeoutSec: 0.1 }))).rejects.toMatchObject({ code: 'MOMO_TIMEOUT', retriable: false });
    expect(calls).toBe(1);
  });
  it('已收到响应头但正文卡住，同样受总等待预算限制', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); };
    await expect(generateContent(options({ runTimeoutSec: 0.1 }))).rejects.toMatchObject({ code: 'MOMO_TIMEOUT' });
    expect(calls).toBe(1);
  });
  it('仅 429 自动等待后重试，界面收到重试进度', async () => {
    const progress: GenerationProgress[] = [];
    handler = (_req, res) => { if (calls === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end('{}'); } else res.end(JSON.stringify(image)); };
    await generateContent({ ...options(), onProgress: (p) => progress.push(p) });
    expect(calls).toBe(2);
    expect(progress.map((p) => p.stage)).toEqual(['generating', 'retrying', 'generating']);
    expect(progress.at(-1)?.attempt).toBe(2);
  });
  it('限流要求等待超过预算时不重发', async () => {
    handler = (_req, res) => { res.writeHead(429, { 'Retry-After': '20' }); res.end('{}'); };
    await expect(generateContent(options({ runTimeoutSec: 1 }))).rejects.toMatchObject({ code: 'MOMO_RATE_LIMITED' });
    expect(calls).toBe(1);
  });
  it('限流等待时取消，及时结束且不再次提交', async () => {
    const ctrl = new AbortController();
    handler = (_req, res) => { res.writeHead(429); res.end('{}'); };
    await expect(generateContent({ ...options(), signal: ctrl.signal, onProgress: (p) => { if (p.stage === 'retrying') ctrl.abort(); } })).rejects.toMatchObject({ code: 'CANCELED' });
    expect(calls).toBe(1);
  });
  it('请求开始前取消，不向远端发送请求', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    await expect(generateContent({ ...options(), signal: ctrl.signal })).rejects.toMatchObject({ code: 'CANCELED' });
    expect(calls).toBe(0);
  });
});
