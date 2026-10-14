import { decodeKey, isMockMode, loadSettings, type AppSettings } from './settings';
import { logLine } from './logger';

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
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function authHeader(s: AppSettings): string {
  return `Bearer ${decodeKey(s.apiKey)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new MomoError('CANCELED', '已取消'));
      },
      { once: true }
    );
  });
}

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new MomoError('MOMO_TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)}秒）`, { retriable: true })), timeoutMs);
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

/** 主接口：nano-banana 系 generateContent（§7.1）。含 429/5xx/网络错误的重试（2s/8s/20s）。 */
export async function generateContent(opts: GenerateOptions): Promise<GenerateResult> {
  const s = opts.settings ?? loadSettings();

  if (isMockMode(s)) {
    if (!opts.mockReturn) throw new MomoError('MOCK_NO_SOURCE', '模拟模式缺少模拟返回图');
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

  let lastErr: MomoError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1];
      logLine('warn', `墨墨请求失败（${lastErr?.code}），${delay / 1000}s 后重试（第 ${attempt} 次重试）`);
      await sleep(delay, opts.signal);
    }
    const combined = combineSignals(s.runTimeoutSec * 1000, opts.signal);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader(s), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined.signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        throw new MomoError('MOMO_API_KEY_INVALID', 'API Key 无效或过期', { status: resp.status });
      }
      if (resp.status === 429) {
        throw new MomoError('MOMO_RATE_LIMITED', '请求频率受限（429）', { status: 429, retriable: true });
      }
      if (resp.status >= 500) {
        throw new MomoError('MOMO_HTTP_5XX', `服务端错误（HTTP ${resp.status}）`, { status: resp.status, retriable: true });
      }
      if (resp.status === 404) {
        throw new MomoError('MOMO_UNSUPPORTED', `接口不支持（HTTP 404）: ${url}`, { status: 404 });
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new MomoError('MOMO_HTTP_ERROR', `HTTP ${resp.status}: ${text.slice(0, 300)}`, { status: resp.status });
      }

      const json = (await resp.json()) as {
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
      return { mime: part.inlineData.mimeType || 'image/png', base64: part.inlineData.data, raw: json };
    } catch (e) {
      const err = toMomoError(e);
      if (err.code === 'CANCELED') throw err;
      if (!err.retriable) throw err;
      lastErr = err;
    } finally {
      combined.dispose();
    }
  }
  throw lastErr ?? new MomoError('MOMO_NETWORK', '请求失败');
}

function toMomoError(e: unknown): MomoError {
  if (e instanceof MomoError) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new MomoError('MOMO_TIMEOUT', '请求超时', { retriable: true });
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(e.message)) {
      return new MomoError('MOMO_NETWORK', `网络错误：${e.message}`, { retriable: true });
    }
    return new MomoError('MOMO_NETWORK', e.message, { retriable: true });
  }
  return new MomoError('MOMO_NETWORK', String(e), { retriable: true });
}

/** §7.4 备用接口（P1）：OpenAI 兼容 images/edits?async=true + 任务轮询。仅在主接口返回“接口不支持”时尝试。 */
export async function generateViaOpenAIFallback(opts: GenerateOptions): Promise<GenerateResult> {
  const s = opts.settings ?? loadSettings();
  if (isMockMode(s)) {
    if (!opts.mockReturn) throw new MomoError('MOCK_NO_SOURCE', '模拟模式缺少模拟返回图');
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
