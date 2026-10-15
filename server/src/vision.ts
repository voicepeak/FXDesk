import { request } from 'undici';
import { decodeKey, isMockMode, loadSettings, type AppSettings } from './settings';
import { detectProvider } from './momo';
import { logLine } from './logger';

export class VisionError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, opts?: { status?: number }) {
    super(message);
    this.code = code;
    this.status = opts?.status;
  }
}

export interface VisionImage {
  mime: string;
  base64: string;
}

export interface VisionChatOptions {
  images: VisionImage[];
  systemPrompt: string;
  userPrompt: string;
  modelId?: string;
  settings?: AppSettings;
  signal?: AbortSignal;
  context?: string;
}

export interface VisionChatResult {
  text: string;
  path: 'chat' | 'gemini';
  raw: unknown;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/** OpenAI 兼容 chat/completions 请求体（豆包、通义、各类中转站通用） */
export function buildChatBody(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  images: VisionImage[],
  opts?: { disableThinking?: boolean }
): Record<string, unknown> {
  const content: unknown[] = [{ type: 'text', text: userPrompt }];
  for (const im of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } });
  }
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
    temperature: 0.3,
    max_tokens: 4096,
    stream: false,
  };
  // 豆包 Seed 系思考模型：关闭思考大幅提速，且避免思维链占满输出预算
  if (opts?.disableThinking) body.thinking = { type: 'disabled' };
  return body;
}

/** Gemini 兼容 generateContent 请求体（墨墨原始协议） */
export function buildGeminiBody(systemPrompt: string, userPrompt: string, images: VisionImage[]): Record<string, unknown> {
  const parts: unknown[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
  for (const im of images) {
    parts.push({ inlineData: { mimeType: im.mime, data: im.base64 } });
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.3 },
  };
}

/** 从 chat/completions 响应中提取文本（content 可能是字符串或分段数组） */
export function extractChatText(json: unknown): string {
  const data = json as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
  if (data?.error?.message) throw new VisionError('VISION_HTTP_FAILED', `分析接口返回错误：${data.error.message}`);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
}

/** 从 generateContent 响应中提取文本 */
export function extractGeminiText(json: unknown): string {
  const data = json as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
  } | null;
  if (data?.error?.message) throw new VisionError('VISION_HTTP_FAILED', `分析接口返回错误：${data.error.message}`);
  if (data?.promptFeedback?.blockReason) throw new VisionError('VISION_SAFETY_BLOCKED', '请求被安全策略拦截');
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('').trim();
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 markdown 代码块与前后解释文字） */
export function extractJsonObject(text: string): unknown {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new VisionError('VISION_OUTPUT_NOT_JSON', '模型未返回可解析的 JSON 结果');
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    throw new VisionError('VISION_OUTPUT_NOT_JSON', `模型返回的 JSON 无法解析：${slice.slice(0, 120)}…`);
  }
}

function shouldFallback(status: number, bodyText: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (
    (status === 400 || status === 422) &&
    /not\s*found|unsupported|unknown\s*path|invalid\s*(url|path|endpoint)|not\s*a\s+valid\s+.*model|不支持|无法找到|不存在/i.test(bodyText)
  ) {
    return true;
  }
  return false;
}

function authError(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  return /apikey|api\s*key|unauthorized|invalid\s*token/i.test(bodyText);
}

interface Attempt {
  path: 'chat' | 'gemini';
  url: string;
  body: Record<string, unknown>;
  parse: (json: unknown) => string;
}

/** 分析接口协议尝试顺序：显式协议优先，否则按服务商自动（GrsAI 系优先 OpenAI 兼容，其余优先 Gemini 兼容） */
export function visionProtocolOrder(s: AppSettings): ('chat' | 'gemini')[] {
  if (s.analysisProtocol === 'openai') return ['chat', 'gemini'];
  if (s.analysisProtocol === 'gemini') return ['gemini', 'chat'];
  return detectProvider(s) === 'grsai' ? ['chat', 'gemini'] : ['gemini', 'chat'];
}

function attemptsFor(s: AppSettings, modelId: string, systemPrompt: string, userPrompt: string, images: VisionImage[]): Attempt[] {
  // 容错：Base URL 若已带 /v1 后缀，避免拼成 /v1/v1/...
  const base = trimSlash(s.baseUrl).replace(/\/v1$/i, '');
  const chat: Attempt = {
    path: 'chat',
    url: `${base}/v1/chat/completions`,
    body: buildChatBody(modelId, systemPrompt, userPrompt, images, { disableThinking: s.analysisDisableThinking }),
    parse: extractChatText,
  };
  const gemini: Attempt = {
    path: 'gemini',
    url: `${base}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
    body: buildGeminiBody(systemPrompt, userPrompt, images),
    parse: extractGeminiText,
  };
  const byPath = { chat, gemini };
  return visionProtocolOrder(s).map((p) => byPath[p]);
}

async function postJson(url: string, s: AppSettings, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: unknown; text: string }> {
  const resp = await request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${decodeKey(s.apiKey)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const text = await resp.body.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: resp.statusCode, json, text };
}

/**
 * 多模态分析调用（AI 筹备：识别 / 特效见解）。
 * 按服务商自动选择协议：GrsAI 优先 OpenAI 兼容 chat/completions，墨墨优先 Gemini 兼容 :generateContent；
 * 路径不存在（404/405/明确不支持）时自动换另一种协议重试一次。仅 429 按 Retry-After 等待一次。
 */
export async function visionChat(opts: VisionChatOptions): Promise<VisionChatResult> {
  const s = opts.settings ?? loadSettings();
  const modelId = (opts.modelId ?? s.analysisModelId ?? '').trim();
  if (!modelId) throw new VisionError('VISION_NO_MODEL', '未配置分析模型 ID，请到设置页「AI 筹备」填写');
  if (isMockMode(s)) throw new VisionError('VISION_MOCK', '模拟模式下不调用分析接口');
  if (!s.apiKey) throw new VisionError('VISION_AUTH', 'API Key 未配置，请到设置页填写');

  const timeoutMs = Math.max(30, s.analysisTimeoutSec || 180) * 1000;
  const deadline = Date.now() + timeoutMs;
  const attempts = attemptsFor(s, modelId, opts.systemPrompt, opts.userPrompt, opts.images);
  let lastError: VisionError | null = null;

  for (const attempt of attempts) {
    const startedAt = Date.now();
    try {
      let r = await postJson(attempt.url, s, attempt.body, Math.max(1000, deadline - Date.now()), opts.signal);
      // 中转站不认识 thinking 参数（严格 OpenAI 兼容）→ 去掉该参数重试一次
      if (
        r.status >= 400 &&
        r.status < 500 &&
        attempt.path === 'chat' &&
        'thinking' in attempt.body &&
        /thinking|unrecognized|unknown|extra|invalid.*param|不支持的参数/i.test(r.text.slice(0, 500))
      ) {
        logLine('warn', '中转站不支持 thinking 参数，去掉后重试');
        const bodyNoThink = { ...attempt.body };
        delete (bodyNoThink as Record<string, unknown>).thinking;
        r = await postJson(attempt.url, s, bodyNoThink, Math.max(1000, deadline - Date.now()), opts.signal);
      }
      if (r.status === 429) {
        const retryAfter = 3000;
        if (deadline - Date.now() > retryAfter + 1000) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          r = await postJson(attempt.url, s, attempt.body, Math.max(1000, deadline - Date.now()), opts.signal);
        }
      }
      if (r.status >= 200 && r.status < 300) {
        const text = attempt.parse(r.json);
        if (!text) {
          throw new VisionError(
            'VISION_EMPTY',
            '分析接口未返回文本内容（思考型模型可能把输出预算耗在思维链上：可保持「关闭思考」开启，或改用非思考版模型/调大输出上限）'
          );
        }
        logLine('info', `视觉分析完成（${attempt.path}·${modelId}）：${Math.round((Date.now() - startedAt) / 1000)} 秒`, { context: opts.context });
        return { text, path: attempt.path, raw: r.json };
      }
      const bodyText = r.text.slice(0, 500);
      const err = authError(r.status, bodyText)
        ? new VisionError('VISION_AUTH', 'API Key 无效或过期', { status: r.status })
        : new VisionError('VISION_HTTP_FAILED', `分析接口失败（HTTP ${r.status}）：${bodyText.slice(0, 160)}`, { status: r.status });
      if (err.code === 'VISION_AUTH' || !shouldFallback(r.status, bodyText)) throw err;
      logLine('warn', `分析接口路径 ${attempt.path} 不可用（HTTP ${r.status}），尝试备用协议`);
      lastError = err;
    } catch (e) {
      if (opts.signal?.aborted) throw new VisionError('VISION_CANCELED', '已取消');
      const verr = e instanceof VisionError ? e : new VisionError('VISION_HTTP_FAILED', e instanceof Error ? e.message : String(e));
      if (verr.code === 'VISION_AUTH' || verr.code === 'VISION_SAFETY_BLOCKED' || verr.code === 'VISION_EMPTY') throw verr;
      lastError = verr;
      if (/HTTP (404|405|501)/.test(verr.message)) {
        logLine('warn', `分析接口路径 ${attempt.path} 不存在，尝试备用协议`);
        continue;
      }
      if (Date.now() >= deadline || /timeout|timed?\s*out|超时/i.test(verr.message)) {
        throw new VisionError('VISION_TIMEOUT', `分析等待超过 ${Math.round(timeoutMs / 1000)} 秒，请稍后重试`);
      }
      throw verr;
    }
  }
  throw lastError ?? new VisionError('VISION_HTTP_FAILED', '分析接口调用失败');
}
