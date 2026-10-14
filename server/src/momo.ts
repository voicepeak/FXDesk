import { decodeKey, isMockMode, loadSettings, type AppSettings } from './settings';
import { logLine } from './logger';
import { request } from 'undici';
import { randomUUID } from 'node:crypto';

export class MomoError extends Error {
  code: string;
  status?: number;
  retriable: boolean;
  constructor(code: string, message: string, opts?: { status?: number; retriable?: boolean }) {
    super(message);
    this.code = code;
    this.status = opts?.status;
    this.retriable = opts?.retriable ?? false;
  }
}

export interface ImagePart {
  mime: string;
  base64: string;
}

export interface GenerateResult {
  mime: string;
  base64: string;
  raw?: unknown;
  cost?: number;
  mocked?: boolean;
}

export interface GenerateOptions {
  images: ImagePart[];
  prompt: string;
  signal?: AbortSignal;
  settings?: AppSettings;
  /** mock 模式下返回的图片（模拟模型返回），由管线提供 */
  mockReturn?: ImagePart;
  context?: { jobId: string; runId: string };
  onProgress?: (progress: GenerationProgress) => void;
}

export interface GenerationProgress {
  stage: 'generating' | 'retrying';
  attempt: number;
  message: string;
  retryAt?: number;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function authHeader(s: AppSettings): string {
  return `Bearer ${decodeKey(s.apiKey)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new MomoError('CANCELED', '已取消')); return; }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); cleanup(); reject(signal?.reason ?? new MomoError('CANCELED', '已取消')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 模拟模式下模拟真实生成耗时（默认 2.2s，便于观察 排队→生成→质检 全流程；FXDESK_MOCK_LATENCY_MS=0 可关闭） */
async function mockLatency(signal?: AbortSignal): Promise<void> {
  const ms = Number(process.env.FXDESK_MOCK_LATENCY_MS ?? 2200);
  if (Number.isFinite(ms) && ms > 0) await sleep(ms, signal);
}

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new MomoError('MOMO_TIMEOUT', `等待超过 ${Math.round(timeoutMs / 1000)} 秒；远端可能已生成或扣费，请先核对远端记录后再重试`)), timeoutMs);
  const onAbort = () => ctrl.abort(external?.reason instanceof Error ? external.reason : new MomoError('CANCELED', '已取消'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(t);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

const RETRY_DELAYS = [2000, 8000, 20000];

/** 同步生成：整个调用共享等待预算；仅明确拒绝的 429 可自动重试。 */
export async function generateContent(opts: GenerateOptions): Promise<GenerateResult> {
  const s = opts.settings ?? loadSettings();

  if (isMockMode(s)) {
    if (!opts.mockReturn) throw new MomoError('MOCK_NO_SOURCE', '模拟模式缺少模拟返回图');
    await mockLatency(opts.signal);
    return { mime: opts.mockReturn.mime, base64: opts.mockReturn.base64, mocked: true, raw: { mock: true } };
  }

  if (!s.apiKey) throw new MomoError('MOMO_API_KEY_INVALID', 'API Key 未配置', { retriable: false });

  const url = `${trimSlash(s.baseUrl)}/v1beta/models/${encodeURIComponent(s.modelId)}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [
          ...opts.images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.base64 } })),
          { text: opts.prompt },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { imageSize: s.imageSize, ...(s.aspectRatio ? { aspectRatio: s.aspectRatio } : {}) },
    },
  };

  const timeoutMs = s.runTimeoutSec * 1000;
  const deadline = Date.now() + timeoutMs;
  const combined = combineSignals(timeoutMs, opts.signal);
  const requestBody = JSON.stringify(body);
  let requestId: string | undefined;
  let localRequestId: string | undefined;
  let attempt = 0;
  try {
    for (; attempt <= RETRY_DELAYS.length; attempt++) {
      if (combined.signal.aborted) throw combined.signal.reason;
      localRequestId = randomUUID();
      const attemptStartedAt = Date.now();
      requestId = undefined;
      opts.onProgress?.({ stage: 'generating', attempt: attempt + 1, message: attempt ? `远端限流后重新提交（第 ${attempt + 1} 次）` : '等待远端生成结果' });
      logLine('info', '墨墨生成请求开始', { ...opts.context, localRequestId, attempt: attempt + 1, model: s.modelId, imageSize: s.imageSize, imageCount: opts.images.length, requestBytes: Buffer.byteLength(requestBody), timeoutSec: s.runTimeoutSec });
      // request allows explicit read/header timeouts; built-in fetch has a separate 300s header limit.
      const resp = await request(url, {
        method: 'POST',
        headers: { Authorization: authHeader(s), 'Content-Type': 'application/json' },
        body: requestBody,
        signal: combined.signal,
        headersTimeout: Math.max(1, deadline - Date.now()),
        bodyTimeout: Math.max(1, deadline - Date.now()),
      });
      const remoteId = resp.headers['x-request-id'] ?? resp.headers['request-id'];
      requestId = Array.isArray(remoteId) ? remoteId[0] : remoteId;
      logLine('info', '墨墨生成响应头', { ...opts.context, localRequestId, requestId, attempt: attempt + 1, status: resp.statusCode, elapsedMs: Date.now() - attemptStartedAt });
      if (resp.statusCode === 429) {
        await resp.body.dump();
        if (attempt === RETRY_DELAYS.length) throw new MomoError('MOMO_RATE_LIMITED', '远端持续限流，请降低并行生成数后再试', { status: 429 });
        const retryHeader = String(resp.headers['retry-after'] ?? '');
        const retryMs = /^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now();
        const delay = Math.max(RETRY_DELAYS[attempt], Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0);
        if (delay >= deadline - Date.now()) throw new MomoError('MOMO_RATE_LIMITED', '远端限流等待超过本次时间预算，请稍后重试或降低并行生成数', { status: 429 });
        const message = `远端限流，${Math.ceil(delay / 1000)} 秒后重试`;
        opts.onProgress?.({ stage: 'retrying', attempt: attempt + 1, message, retryAt: Date.now() + delay });
        logLine('warn', message, { ...opts.context, localRequestId, requestId, attempt: attempt + 1 });
        await sleep(delay, combined.signal);
        continue;
      }
      if (resp.statusCode === 401 || resp.statusCode === 403) {
        await resp.body.dump();
        throw new MomoError('MOMO_API_KEY_INVALID', 'API Key 无效或过期', { status: resp.statusCode });
      }
      if (resp.statusCode >= 500) {
        await resp.body.dump();
        throw new MomoError('MOMO_HTTP_5XX', `远端服务异常（HTTP ${resp.statusCode}）；远端可能已生成或扣费，请先核对远端记录后再重试`, { status: resp.statusCode });
      }
      if (resp.statusCode === 404) {
        await resp.body.dump();
        throw new MomoError('MOMO_UNSUPPORTED', `接口不支持（HTTP 404）: ${url}`, { status: 404 });
      }
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        await resp.body.dump();
        throw new MomoError('MOMO_HTTP_ERROR', `远端返回 HTTP ${resp.statusCode}`, { status: resp.statusCode });
      }

      const json = (await resp.body.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
        error?: { message?: string };
      };

      if (json.promptFeedback?.blockReason) {
        throw new MomoError('MOMO_SAFETY_BLOCKED', `请求被安全策略拦截（${json.promptFeedback.blockReason}）`);
      }
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) {
        const emsg = json.error?.message ?? '';
        if (/not\s*support|unsupported|invalid\s*model/i.test(emsg)) {
          throw new MomoError('MOMO_UNSUPPORTED', `接口不支持：${emsg}`);
        }
        throw new MomoError('MOMO_NO_IMAGE', '模型未返回图像');
      }
      logLine('info', '墨墨生成结果接收完成', { ...opts.context, localRequestId, requestId, attempt: attempt + 1, elapsedMs: Date.now() - attemptStartedAt });
      return { mime: part.inlineData.mimeType || 'image/png', base64: part.inlineData.data, raw: json };
    }
    throw new MomoError('MOMO_RATE_LIMITED', '远端持续限流');
  } catch (e) {
    const err = opts.signal?.aborted ? new MomoError('CANCELED', '已停止本地等待；远端任务可能仍在运行，请核对远端记录') : toMomoError(combined.signal.aborted ? combined.signal.reason : e);
    const cause = e instanceof Error ? (e as Error & { cause?: { code?: string; message?: string }; code?: string }) : undefined;
    const scrub = (value: string | undefined) => value?.split(decodeKey(s.apiKey)).join('[REDACTED]').slice(0, 300);
    logLine('error', '墨墨生成请求结束（未收到有效结果）', { ...opts.context, localRequestId, requestId, attempt: attempt + 1, code: err.code, status: err.status, message: scrub(err.message), causeCode: cause?.cause?.code ?? cause?.code, causeMessage: e instanceof SyntaxError ? '响应不是有效 JSON' : scrub(cause?.cause?.message ?? cause?.message) });
    throw err;
  } finally {
    combined.dispose();
  }
}

function toMomoError(e: unknown): MomoError {
  if (e instanceof MomoError) return e;
  if (e instanceof Error) {
    if (e instanceof SyntaxError) return new MomoError('MOMO_RESPONSE_INVALID', '远端响应格式异常；远端可能已生成或扣费，请先核对远端记录后再重试');
    const code = (e as Error & { code?: string; cause?: { code?: string } }).code ?? (e as Error & { cause?: { code?: string } }).cause?.code ?? '';
    if (e.name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code)) return new MomoError('MOMO_TIMEOUT', '请求超时；远端可能已生成或扣费，请先核对远端记录后再重试');
    return new MomoError('MOMO_NETWORK', '生成连接中断，未收到完整结果；远端可能已生成或扣费，请先核对远端记录后再重试');
  }
  return new MomoError('MOMO_NETWORK', '未收到生成结果；远端可能已生成或扣费，请先核对远端记录后再重试');
}

/** §7.4 备用接口（P1）：OpenAI 兼容 images/edits?async=true + 任务轮询。仅在主接口返回“接口不支持”时尝试。 */
export async function generateViaOpenAIFallback(opts: GenerateOptions): Promise<GenerateResult> {
  const s = opts.settings ?? loadSettings();
  if (isMockMode(s)) {
    if (!opts.mockReturn) throw new MomoError('MOCK_NO_SOURCE', '模拟模式缺少模拟返回图');
    await mockLatency(opts.signal);
    return { mime: opts.mockReturn.mime, base64: opts.mockReturn.base64, mocked: true };
  }
  const base = trimSlash(s.baseUrl);
  const form = new FormData();
  form.append('model', s.modelId);
  form.append('prompt', opts.prompt);
  opts.images.forEach((img, i) => {
    const buf = Buffer.from(img.base64, 'base64');
    form.append('image', new Blob([new Uint8Array(buf)], { type: img.mime }), `image_${i + 1}.${img.mime === 'image/png' ? 'png' : 'jpg'}`);
  });

  const submit = await fetch(`${base}/v1/images/edits?async=true`, {
    method: 'POST',
    headers: { Authorization: authHeader(s) },
    body: form,
    signal: opts.signal,
  });
  if (!submit.ok) {
    throw new MomoError('MOMO_FALLBACK_FAILED', `备用接口提交失败 HTTP ${submit.status}`);
  }
  const sj = (await submit.json()) as { task_id?: string; id?: string; data?: { task_id?: string } };
  const taskId = sj.task_id ?? sj.id ?? sj.data?.task_id;
  if (!taskId) throw new MomoError('MOMO_FALLBACK_FAILED', '备用接口未返回 task_id');

  const deadline = Date.now() + s.runTimeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(5000, opts.signal);
    const pr = await fetch(`${base}/v1/images/tasks/${taskId}`, { headers: { Authorization: authHeader(s) }, signal: opts.signal });
    if (!pr.ok) continue;
    const pj = (await pr.json()) as {
      status?: string;
      data?: { status?: string; b64_json?: string; url?: string; data?: { b64_json?: string; url?: string }[] }[];
      result?: { b64_json?: string; url?: string };
    };
    const status = (pj.status ?? pj.data?.[0]?.status ?? '').toLowerCase();
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
      const direct = pj.data?.[0]?.b64_json ?? pj.result?.b64_json;
      if (direct) return { mime: 'image/png', base64: direct };
      const url = pj.data?.[0]?.url ?? pj.result?.url;
      if (url) {
        const ir = await fetch(url);
        const buf = Buffer.from(await ir.arrayBuffer());
        return { mime: ir.headers.get('content-type') || 'image/png', base64: buf.toString('base64') };
      }
      throw new MomoError('MOMO_FALLBACK_FAILED', '备用接口完成但无图像数据');
    }
    if (['failed', 'error', 'canceled'].includes(status)) {
      throw new MomoError('MOMO_FALLBACK_FAILED', '备用接口任务失败');
    }
  }
  throw new MomoError('MOMO_TIMEOUT', '备用接口任务超时', { retriable: false });
}

/** 带备用接口回退的主调用入口 */
export async function generateWithFallback(opts: GenerateOptions): Promise<GenerateResult> {
  try {
    return await generateContent(opts);
  } catch (e) {
    if (e instanceof MomoError && e.code === 'MOMO_UNSUPPORTED') {
      logLine('warn', '主接口不支持，尝试 OpenAI 兼容备用接口（§7.4）');
      return await generateViaOpenAIFallback(opts);
    }
    throw e;
  }
}

export async function listModels(s?: AppSettings): Promise<string[]> {
  const st = s ?? loadSettings();
  if (isMockMode(st)) return ['[Mo]nano-banana-pro', '[yu]gemini-nano-banana-2.1', 'gpt-image-2.5-sunburst'];
  const resp = await fetch(`${trimSlash(st.baseUrl)}/v1/models`, { headers: { Authorization: authHeader(st) } });
  if (resp.status === 401 || resp.status === 403) throw new MomoError('MOMO_API_KEY_INVALID', 'API Key 无效或过期', { status: resp.status });
  if (!resp.ok) throw new MomoError('MOMO_HTTP_ERROR', `HTTP ${resp.status}`);
  const j = (await resp.json()) as { data?: { id?: string }[] };
  return (j.data ?? []).map((d) => d.id ?? '').filter(Boolean);
}

export interface BalanceInfo {
  balance: number;
  remainQuota: number;
  totalGranted: number;
  totalUsed: number;
}

export async function getBalance(s?: AppSettings): Promise<BalanceInfo> {
  const st = s ?? loadSettings();
  if (isMockMode(st)) return { balance: 99.9, remainQuota: 9990000, totalGranted: 10000000, totalUsed: 10000 };
  const resp = await fetch(`${trimSlash(st.baseUrl)}/api/usage/token/`, { headers: { Authorization: authHeader(st) } });
  if (resp.status === 401 || resp.status === 403) throw new MomoError('MOMO_API_KEY_INVALID', 'API Key 无效或过期', { status: resp.status });
  if (!resp.ok) throw new MomoError('MOMO_HTTP_ERROR', `HTTP ${resp.status}`);
  const j = (await resp.json()) as { data?: { balance_cny?: number; remain_quota?: number; total_granted?: number; total_used?: number } };
  const d = j.data ?? {};
  return {
    balance: Number(d.balance_cny ?? 0),
    remainQuota: Number(d.remain_quota ?? 0),
    totalGranted: Number(d.total_granted ?? 0),
    totalUsed: Number(d.total_used ?? 0),
  };
}
