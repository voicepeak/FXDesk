import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { ws } from './env';
import { logLine } from './logger';
import { removePath } from './fsSafe';

export class DoubaoError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface DoubaoVisionImage {
  mime: string;
  base64: string;
}

/**
 * 豆包网页版 DOM 选择器（2026-10 实测；改版时优先在此处调整；每项按顺序尝试）。
 * 说明：网页版没有对外承诺的接口，属浏览器自动化实现，改版或风控时可能失效。
 */
export const DOUBAO_SELECTORS = {
  composer: ['[data-testid="chat_input_input"]', 'div.tiptap.ProseMirror', 'div[contenteditable="true"]', 'textarea'],
  uploadButton: ['[data-testid="upload_file_button"]'],
  uploadMenuItems: ['text=上传文件或图片', 'text=上传文件', 'text=上传图片'],
  fileInput: ['input[data-testid="upload-file-input"]', 'input[type="file"]'],
  stopButton: ['[data-testid="chat_input_stop_button"]', '[data-testid*="stop"]', 'button:has-text("停止")'],
  conversation: ['[data-testid="chat_messages"]', '[class*="message-list"]', '[class*="chat-message"]', 'main'],
  newChat: [
    '[data-testid="create_conversation_button"]',
    'button:has-text("新建对话")',
    'button:has-text("新对话")',
    '[aria-label*="新建对话"]',
  ],
  loginMarkers: ['扫码登录', '验证码登录', '手机号登录', '登录/注册'],
  securityTexts: ['安全限制', '操作过于频繁', 'IP存在风险', '账号存在风险', '访问受限'],
};

const DOUBAO_HOME = 'https://www.doubao.com/chat/';
const LATEST_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export function doubaoProfileDir(): string {
  return ws('doubao-profile');
}

export function doubaoTmpDir(): string {
  return ws('doubao-tmp');
}

export function doubaoBrowserInstalled(): boolean {
  try {
    const exe = chromium.executablePath();
    return Boolean(exe) && fs.existsSync(exe);
  } catch {
    return false;
  }
}

/* ---------------- 文本拼接 / 回复提取（纯函数，可单测） ---------------- */

/** 网页聊天没有 system 角色：把系统提示并入用户消息 */
export function mergeWebPrompt(systemPrompt: string, userPrompt: string): string {
  const sys = systemPrompt.trim();
  const user = userPrompt.trim();
  return sys ? `${sys}\n\n${user}` : user;
}

/**
 * 从「发送前的会话文本」与「完成后的会话文本」中提取新增回复：
 * 取最长公共前缀后的剩余部分；若页面重排导致不是前缀，则返回全文并去掉开头的提问。
 */
export function extractNewReply(before: string, after: string, promptSent?: string): string {
  let common = 0;
  const max = Math.min(before.length, after.length);
  while (common < max && before[common] === after[common]) common++;
  let reply = after.slice(common);
  if (!reply.trim()) reply = after;
  if (promptSent) {
    const p = promptSent.trim();
    if (p && reply.trim().startsWith(p)) reply = reply.trim().slice(p.length);
  }
  return reply.replace(/^\s+/, '').trim();
}

/** 思考中/生成中的页面标记：出现时绝不能判定为「已完成」 */
const THINKING_RE = /正在思考|思考中|深度思考|生成中|正在生成/;

/** 去除回复两端混入的页面小标签（展开全部/时间戳/思考标记等） */
function stripArtifactEdges(text: string): string {
  const artifact = /^\s*(展开全部|收起|复制|重新生成|点赞|点踩|分享|今天\s*\d{1,2}:\d{2}|昨天\s*\d{1,2}:\d{2}|\d{1,2}:\d{2}(:\d{2})?|正在思考|思考中|深度思考|生成中|豆包)\s*$/;
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && (lines[start].trim() === '' || artifact.test(lines[start]))) start++;
  let end = lines.length - 1;
  while (end >= start && (lines[end].trim() === '' || artifact.test(lines[end]))) end--;
  return lines.slice(start, end + 1).join('\n').trim();
}

/**
 * 用「提示词尾部」作为锚点定位回复：取页面文本中最后一次出现锚点之后的内容。
 * 作用：发送后页面会整页重排并回显我们的提问（含模板示例 JSON），直接做文本 diff 会把回显误当回复；
 * 锚点法能稳定跳过回显，拿到真正的模型输出。空白不敏感匹配，容忍页面渲染差异。
 */
export function extractReplyAfterPrompt(fullText: string, prompt: string): string {
  const tail = prompt.trim().slice(-40);
  const norm = (s: string) => s.replace(/\s+/g, '');
  const nText = norm(fullText);
  const nTail = norm(tail);
  if (!nTail || !nText) return '';
  const idx = nText.lastIndexOf(nTail);
  if (idx < 0) return '';
  const target = idx + nTail.length; // 锚点结尾在归一化文本中的下一个位置（1-based 计数）
  let count = 0;
  let real = 0;
  for (let i = 0; i < fullText.length; i++) {
    if (!/\s/.test(fullText[i])) {
      count++;
      if (count === target) {
        real = i + 1;
        break;
      }
    }
  }
  return stripArtifactEdges(fullText.slice(real));
}

/* ---------------- 浏览器会话（串行） ---------------- */

type LoginState = 'idle' | 'waiting' | 'done' | 'error';

let loginState: LoginState = 'idle';
let loginError = '';

export function doubaoLoginInfo(): { state: LoginState; error: string } {
  return { state: loginState, error: loginError };
}

let profileQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = profileQueue.then(
    () => fn(),
    () => fn()
  );
  profileQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanProfileLocks(): void {
  const dir = doubaoProfileDir();
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try {
      removePath(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
}

async function launchBrowser(headless: boolean, opts?: { offscreen?: boolean }): Promise<BrowserContext> {
  fs.mkdirSync(doubaoProfileDir(), { recursive: true });
  cleanProfileLocks();
  const args = ['--disable-blink-features=AutomationControlled'];
  if (!headless && opts?.offscreen && process.env.FXDESK_DOUBAO_WINDOWED !== '1') {
    // 放到屏幕外运行：不打扰用户，同时窗口保持"正常状态"避免被浏览器后台节流
    args.push('--window-position=-32000,-32000');
  }
  try {
    return await chromium.launchPersistentContext(doubaoProfileDir(), {
      headless,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      userAgent: LATEST_CHROME_UA,
      args,
    });
  } catch {
    throw new DoubaoError('BROWSER_MISSING', '浏览器组件未安装或启动失败，请先运行 npx playwright install chromium', 500);
  }
}

async function bodyText(page: Page): Promise<string> {
  try {
    return (await page.evaluate(() => {
      const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
      return doc?.body?.innerText ?? '';
    })) as string;
  } catch {
    return '';
  }
}

function loginMarkersPresent(text: string): boolean {
  if (DOUBAO_SELECTORS.loginMarkers.some((m) => text.includes(m))) return true;
  // 未登录页面右上角有一个独立的「登录」按钮文字（独立成行）
  if (/(^|\n)\s*登录\s*(\n|$)/.test(text)) return true;
  return false;
}

/** 单次判定：会话 cookie 存在 + 登录按钮不可见 + 无登录文案 + 输入框可见（页面加载中会短暂"都满足"，需上层做连续确认） */
async function loggedInVerdict(ctx: BrowserContext, page: Page): Promise<boolean> {
  try {
    const cookies = await ctx.cookies('https://www.doubao.com').catch(() => []);
    const hasCookie = cookies.some((c) => (c.name === 'sessionid' || c.name === 'sid_tt') && !!c.value);
    if (!hasCookie) return false;
  } catch {
    return false;
  }
  try {
    const loginBtn = page.locator('[data-testid="to_login_button"]').first();
    if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible())) return false;
  } catch {
    /* ignore */
  }
  if (loginMarkersPresent(await bodyText(page))) return false;
  return anyVisible(page, DOUBAO_SELECTORS.composer, 0);
}

/** 真实登录态判定：单次判定连续两次为真，且距开始至少 1.8 秒（规避页面加载竞态与残留 cookie） */
async function detectLoggedIn(ctx: BrowserContext, page: Page, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();
  let streak = 0;
  for (;;) {
    const ok = await loggedInVerdict(ctx, page);
    if (ok) {
      if (Date.now() - start >= 1800) {
        streak++;
        if (streak >= 2) return true;
      }
    } else {
      streak = 0;
    }
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

async function anyVisible(page: Page, selectors: string[], timeoutMs = 0): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
      } catch {
        /* try next */
      }
    }
    if (!timeoutMs || Date.now() >= deadline) return false;
    await sleep(400);
  }
}

async function firstVisible(page: Page, selectors: string[], timeoutMs = 15000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
      } catch {
        /* try next */
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(400);
  }
  throw new DoubaoError('DOUBAO_DOM_CHANGED', `未找到页面元素（${selectors[0]}…）——豆包可能改版或未登录，请联系开发联调选择器`, 502);
}

/** 文件 input 通常是隐藏元素，只要求存在（不能要求可见） */
async function firstAttached(page: Page, selectors: string[], timeoutMs = 8000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) return loc;
      } catch {
        /* try next */
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/**
 * 上传图片。豆包有两种版式：
 * - 经典聊天页：点击上传按钮直接弹出系统文件选择器（filechooser 事件）
 * - 工作版式：点击后弹出菜单（「上传文件或图片 / 选择云盘文件」），需再点菜单项
 * 另先在 DOM 里直接找隐藏 input 兜底。
 */
async function uploadImages(page: Page, files: string[]): Promise<void> {
  const direct = await firstAttached(page, DOUBAO_SELECTORS.fileInput, 1200);
  if (direct) {
    await direct.setInputFiles(files);
    return;
  }
  const btn = await firstVisible(page, DOUBAO_SELECTORS.uploadButton, 5000).catch(() => null);
  if (!btn) throw new DoubaoError('DOUBAO_NO_UPLOAD_BUTTON', '未找到图片上传按钮（豆包可能改版），请联系开发联调选择器', 502);

  const clickAndWait = async (loc: Locator, timeoutMs: number) => {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: timeoutMs });
    await loc.click({ timeout: 5000 }).catch((e: unknown) => logLine('warn', `豆包上传点击异常：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`));
    return chooserPromise.catch(() => null);
  };

  // ① 直接点击上传按钮：经典版式会立刻触发文件选择器
  let chooser = await clickAndWait(btn, 4000);
  if (chooser) {
    await chooser.setFiles(files);
    return;
  }
  // ② 工作版式：菜单项「上传文件或图片」
  for (const sel of DOUBAO_SELECTORS.uploadMenuItems) {
    const item = page.locator(sel).first();
    if ((await item.count()) > 0 && (await item.isVisible().catch(() => false))) {
      chooser = await clickAndWait(item, 6000);
      if (chooser) {
        await chooser.setFiles(files);
        return;
      }
    }
  }
  // ③ 点击后 DOM 里出现的隐藏 input
  const late = await firstAttached(page, DOUBAO_SELECTORS.fileInput, 3000);
  if (late) {
    await late.setInputFiles(files);
    return;
  }
  throw new DoubaoError('DOUBAO_UPLOAD_FAILED', '图片上传失败（未接到文件选择器），请重试', 502);
}

async function readConversation(page: Page): Promise<string> {
  for (const sel of DOUBAO_SELECTORS.conversation) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        const text = await loc.evaluate((el) => (el as unknown as { innerText?: string }).innerText ?? '');
        if (text.trim()) return text;
      }
    } catch {
      /* try next */
    }
  }
  return bodyText(page);
}

async function securityBlocked(page: Page): Promise<string | null> {
  const text = await bodyText(page);
  for (const m of DOUBAO_SELECTORS.securityTexts) {
    if (text.includes(m)) return `豆包网页版提示「${m}」，请稍后重试或切换网络`;
  }
  return null;
}

/**
 * 豆包高峰期算力限流提示（免费版在工作/办公能力高峰时段会返回此类文案）：
 * 识别为明确错误，避免被当作模型回复去做 JSON 解析。
 */
export function isCapacityBlocked(reply: string): boolean {
  return /算力紧张|算力受限|开通订阅|开通豆包订阅|高峰期优先|稍后再试|服务繁忙/.test(reply);
}

/** 发送后豆包可能因风控踢出会话（跳转 ?from_logout=1）：给出明确提示并重置登录态 */function throwIfLoggedOut(page: Page): void {
  let url = '';
  try {
    url = page.url();
  } catch {
    return;
  }
  if (url.includes('from_logout')) {
    loginState = 'idle';
    throw new DoubaoError('LOGIN_REQUIRED', '豆包登录已失效（可能被风控踢出），请到设置页重新扫码登录', 401);
  }
}

/* ---------------- 扫码登录 ---------------- */

export function startDoubaoLogin(): { started: boolean; message: string } {
  if (loginState === 'waiting') {
    return { started: true, message: '登录窗口已打开，请在浏览器窗口中扫码登录豆包' };
  }
  loginState = 'waiting';
  loginError = '';
  void runExclusive(async () => {
    const ctx = await launchBrowser(false);
    let ctxClosed = false;
    ctx.on('close', () => {
      ctxClosed = true;
    });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(DOUBAO_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      const loopStart = Date.now();
      let outcome: 'done' | 'closed' | 'timeout' = 'timeout';
      let lastQrClick = 0;
      let okStreak = 0;
      while (Date.now() < deadline) {
        if (ctxClosed || ctx.pages().length === 0) {
          outcome = 'closed';
          break;
        }
        const verdict = await loggedInVerdict(ctx, page);
        if (verdict) {
          // 连续两次确认且已加载至少 3 秒，才认为真的登录了（规避页面加载竞态）
          if (Date.now() - loopStart > 3000) {
            okStreak++;
            if (okStreak >= 2) {
              outcome = 'done';
              break;
            }
          }
        } else {
          okStreak = 0;
        }
        // 未登录且页面上没看到二维码相关文字时，点一次「登录」按钮让二维码弹出来
        const text = await bodyText(page);
        const qrVisible = text.includes('扫码登录') || text.includes('二维码') || text.includes('验证码登录');
        if (!qrVisible && Date.now() - lastQrClick > 5000) {
          lastQrClick = Date.now();
          try {
            const loginBtn = page.locator('[data-testid="to_login_button"]').first();
            if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible())) {
              await loginBtn.click({ timeout: 3000 }).catch(() => undefined);
            }
          } catch {
            /* ignore */
          }
        }
        await sleep(1500);
      }
      if (outcome === 'done') {
        loginState = 'done';
        loginError = '';
      } else {
        loginState = 'error';
        loginError = outcome === 'closed' ? '登录窗口被关闭，未完成登录' : '登录超时（5 分钟），请重试';
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    logLine('info', `豆包网页版登录${loginState === 'done' ? '成功' : '未完成'}`);
  }).catch((e: unknown) => {
    loginState = 'error';
    loginError = e instanceof Error ? e.message : String(e);
    logLine('error', `豆包登录窗口异常：${loginError}`);
  });
  return { started: true, message: '已打开浏览器窗口，请用手机扫码登录豆包' };
}

/* ---------------- 网页聊天（识别 / 见解） ---------------- */

export interface DoubaoChatOptions {
  images: DoubaoVisionImage[];
  prompt: string;
  timeoutSec: number;
  signal?: AbortSignal;
  context?: string;
  /** 阶段进度回调（用于前端显示：启动/登录检测/上传/等待回复…） */
  onStage?: (stage: string) => void;
}

async function runChatOnce(headless: boolean, opts: DoubaoChatOptions): Promise<string> {
  const ctx = await launchBrowser(headless, { offscreen: true });
  const tmpFiles: string[] = [];
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    opts.onStage?.('已启动浏览器，正在打开豆包…');
    await page.goto(DOUBAO_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);

    opts.onStage?.('正在检查登录状态…');
    if (!(await detectLoggedIn(ctx, page, 10000))) {
      loginState = 'idle';
      throw new DoubaoError('LOGIN_REQUIRED', '尚未登录豆包网页版（或登录已失效），请到设置页扫码登录', 401);
    }
    const blocked = await securityBlocked(page);
    if (blocked) throw new DoubaoError('DOUBAO_SECURITY_BLOCK', blocked, 403);

    // 隔离上下文：若落在历史会话路由上，先回新对话/落地页；在落地页则通常已是新对话
    const convInUrl = /\/chat\/[0-9a-zA-Z_-]{8,}/.test(page.url());
    let openedFresh = false;
    for (const sel of DOUBAO_SELECTORS.newChat) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(1000);
          openedFresh = true;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (convInUrl && !openedFresh) {
      await page.goto(DOUBAO_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }

    const composer = await firstVisible(page, DOUBAO_SELECTORS.composer, 15000);

    // 上传图片（写临时文件后交给页面 hidden input / filechooser）
    if (opts.images.length) {
      opts.onStage?.(`正在上传 ${opts.images.length} 张图片…`);
      fs.mkdirSync(doubaoTmpDir(), { recursive: true });
      for (const [i, im] of opts.images.entries()) {
        const ext = /jpe?g/i.test(im.mime) ? 'jpg' : 'png';
        const p = path.join(doubaoTmpDir(), `${Date.now()}-${i}.${ext}`);
        fs.writeFileSync(p, Buffer.from(im.base64, 'base64'));
        tmpFiles.push(p);
      }
      await uploadImages(page, tmpFiles);
      // 等图片预览就绪
      await page.waitForTimeout(1000 + tmpFiles.length * 350);
    }

    await composer.click();
    // 清空输入框残留（上次失败留下的草稿会与新提示词叠加）
    await page.keyboard.press('Control+A').catch(() => undefined);
    await page.keyboard.press('Backspace').catch(() => undefined);
    await page.waitForTimeout(200);
    await page.keyboard.insertText(opts.prompt);
    await page.waitForTimeout(300);
    opts.onStage?.('已发送，等待豆包回复…');
    await page.keyboard.press('Enter');
    // 首条消息后页面可能整页跳转到会话路由，等导航稳定再开始轮询
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    throwIfLoggedOut(page);

    const timeoutMs = Math.max(30, opts.timeoutSec) * 1000;
    const deadline = Date.now() + timeoutMs;
    const sendAt = Date.now();
    let stable = 0;
    let last = '';
    let finished = false;
    let replyText = '';
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new DoubaoError('DOUBAO_CANCELED', '已取消', 499);
      await page.waitForTimeout(1500);
      throwIfLoggedOut(page);
      let cur: string | null = null;
      try {
        cur = await readConversation(page);
      } catch {
        // 导航导致上下文销毁：本轮跳过，下轮重试
        continue;
      }
      const stopVisible = await anyVisible(page, DOUBAO_SELECTORS.stopButton).catch(() => false);
      if (cur !== last) {
        stable = 0;
        last = cur;
      } else {
        stable++;
      }
      // 只有「锚点之后的真实回复」出现、且已稳定数轮、思考标记消失、距发送有最短时间，才认为完成
      const candidate = extractReplyAfterPrompt(last, opts.prompt);
      const sinceSend = Date.now() - sendAt;
      const thinking = THINKING_RE.test(last.slice(-100));
      if (candidate && stable >= 4 && sinceSend >= 8000 && !stopVisible && !thinking) {
        replyText = candidate;
        finished = true;
        break;
      }
    }
    if (!finished || !replyText) {
      const snapshot = last.slice(-500) || (await bodyText(page).catch(() => '')).slice(0, 400);
      logLine('warn', '豆包网页版未在限时内返回内容', { context: opts.context, snapshot });
      const thinkingNow = THINKING_RE.test(last.slice(-100));
      throw new DoubaoError(
        'DOUBAO_TIMEOUT',
        thinkingNow
          ? `豆包网页版思考超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回结果，请稍后重试`
          : `豆包网页版等待超过 ${Math.round(timeoutMs / 1000)} 秒未返回内容`,
        504
      );
    }

    const reply = replyText.trim();
    if (!reply) throw new DoubaoError('DOUBAO_EMPTY_REPLY', '豆包网页版返回为空（可能被风控），请重试', 502);    if (isCapacityBlocked(reply)) {
      logLine('warn', `豆包网页版算力限流：${reply.slice(0, 120)}`, { context: opts.context });
      throw new DoubaoError('DOUBAO_CAPACITY', '豆包网页版高峰期算力紧张（免费版限流），请稍后重试；频繁出现可考虑开通豆包订阅', 503);
    }
    return reply;
  } finally {
    for (const f of tmpFiles) {
      try {
        removePath(f);
      } catch {
        /* ignore */
      }
    }
    await ctx.close().catch(() => {});
  }
}

/** 豆包网页版对话（图片 + 文本 → 回复文本）。串行访问；默认可见窗口（更接近真人、降低风控概率），FXDESK_DOUBAO_HEADLESS=1 可强制 headless。 */
export async function doubaoWebChat(opts: DoubaoChatOptions): Promise<{ text: string }> {
  if (!doubaoBrowserInstalled()) {
    throw new DoubaoError('BROWSER_MISSING', '浏览器组件未安装，请先运行 npx playwright install chromium', 500);
  }
  if (loginState === 'waiting') throw new DoubaoError('LOGIN_PENDING', '登录窗口还开着，请先完成扫码登录', 409);
  return runExclusive(async () => {
    const headless = process.env.FXDESK_DOUBAO_HEADLESS === '1';
    const text = await runChatOnce(headless, opts);
    return { text };
  });
}
