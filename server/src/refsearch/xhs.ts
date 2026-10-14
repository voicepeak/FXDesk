import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ws } from '../env';
import { logLine } from '../logger';
import { removePath } from '../fsSafe';

export class RefSearchError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface XhsNote {
  id: string;
  noteUrl: string;
  thumbUrl: string;
  title: string;
}

const LATEST_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const XHS_REFERER = 'https://www.xiaohongshu.com/';
const XHS_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_MODAL_SELECTOR = '.login-container, .login-modal, .login-mask';

export function xhsProfileDir(): string {
  return ws('refsearch', 'xhs-profile');
}

export function buildSearchUrl(keyword: string): string {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
}

export function isAllowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host.endsWith('.xhscdn.com') || host.endsWith('.xiaohongshu.com');
}

/** 尽量把 imageView2 缩略图放大到 1440 宽，其他 CDN 格式原样返回。 */
export function upgradeCdnUrl(raw: string): string {
  return raw.replace(/([?&]imageView2\/[^?#]*\/w\/)(\d+)(?=\/|$|&)/, (all, prefix: string, width: string) => {
    return Number(width) >= 1440 ? all : `${prefix}1440`;
  });
}

type LoginState = 'idle' | 'waiting' | 'done' | 'error';

let loginState: LoginState = 'idle';
let loginError = '';
let headlessBlocked = false;

export function xhsLoginInfo(): { state: LoginState; error: string } {
  return { state: loginState, error: loginError };
}

export function xhsBrowserInstalled(): boolean {
  try {
    const exe = chromium.executablePath();
    return Boolean(exe) && fs.existsSync(exe);
  } catch {
    return false;
  }
}

/* ---------------- 浏览器 / 账号配置串行访问 ---------------- */

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
  const dir = xhsProfileDir();
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try {
      removePath(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
}

async function launchBrowser(headless: boolean): Promise<BrowserContext> {
  fs.mkdirSync(xhsProfileDir(), { recursive: true });
  cleanProfileLocks();
  try {
    return await chromium.launchPersistentContext(xhsProfileDir(), {
      headless,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    throw new RefSearchError('BROWSER_MISSING', '浏览器组件未安装或启动失败，请先运行 npx playwright install chromium', 500);
  }
}

async function readBodyText(page: Page): Promise<string> {
  try {
    return (await page.evaluate(() => {
      const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
      return doc?.body?.innerText ?? '';
    })) as string;
  } catch {
    return '';
  }
}

/** 小红书安全限制页（不跳转 URL 时页面内渲染“安全限制 / IP存在风险”）。 */
async function securityBlocked(page: Page): Promise<string | null> {
  try {
    if (page.url().includes('website-login/error')) {
      const m = page.url().match(/[?&]error_msg=([^&]+)/);
      return decodeURIComponent(m?.[1] ?? '被小红书安全限制拦截');
    }
  } catch {
    /* ignore */
  }
  const text = await readBodyText(page);
  if (text.includes('安全限制') || text.includes('IP存在风险')) {
    return '小红书安全限制：IP存在风险，请切换网络或稍后重试';
  }
  return null;
}

async function loginModalCount(page: Page): Promise<number> {
  try {
    return await page.locator(LOGIN_MODAL_SELECTOR).count();
  } catch {
    return 1;
  }
}

/** 用真实的搜索页行为验证是否已登录：游客搜索页必定弹出登录框。 */
async function verifyLoggedIn(ctx: BrowserContext): Promise<'yes' | 'no' | 'unknown'> {
  let vp: Page | null = null;
  try {
    vp = await ctx.newPage();
    await vp.goto(buildSearchUrl('测试'), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await vp.waitForTimeout(5000);
    if (await securityBlocked(vp)) return 'unknown';
    if ((await loginModalCount(vp)) > 0) return 'no';
    const notes = await vp.locator('section.note-item, div.note-item').count().catch(() => 0);
    return notes > 0 ? 'yes' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    await vp?.close().catch(() => {});
  }
}

/* ---------------- 扫码登录 ---------------- */

export function startXhsLogin(): { started: boolean; message: string } {
  if (loginState === 'waiting') {
    return { started: true, message: '登录窗口已打开，请在浏览器窗口中扫码登录' };
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
      await page.goto(XHS_EXPLORE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let sawModal = false;
      let lastVerify = 0;
      let outcome: 'done' | 'closed' | 'blocked' | 'timeout' = 'timeout';
      while (Date.now() < deadline) {
        if (ctxClosed || ctx.pages().length === 0) {
          outcome = 'closed';
          break;
        }
        const block = await securityBlocked(page);
        if (block) {
          loginError = block;
          outcome = 'blocked';
          break;
        }
        const modal = await loginModalCount(page);
        if (modal > 0) sawModal = true;
        const cookies = await ctx.cookies('https://www.xiaohongshu.com').catch(() => []);
        const hasSession = cookies.some((c) => c.name === 'web_session' && c.value);
        if (sawModal && modal === 0 && hasSession && Date.now() - lastVerify > 6000) {
          lastVerify = Date.now();
          const verdict = await verifyLoggedIn(ctx);
          if (verdict === 'yes') {
            outcome = 'done';
            break;
          }
          if (verdict === 'no') {
            sawModal = false;
            await page.goto(XHS_EXPLORE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          }
        }
        await sleep(1500);
      }
      if (outcome === 'done') {
        loginState = 'done';
        loginError = '';
      } else {
        loginState = 'error';
        loginError =
          outcome === 'blocked'
            ? loginError
            : outcome === 'closed'
              ? '登录窗口被关闭，未完成登录'
              : '登录超时（5 分钟），请重试';
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    logLine('info', `小红书登录${loginState === 'done' ? '成功' : '未完成'}`);
  }).catch((e: unknown) => {
    loginState = 'error';
    loginError = e instanceof Error ? e.message : String(e);
    logLine('error', `小红书登录窗口异常：${loginError}`);
  });
  return { started: true, message: '已打开浏览器窗口，请用手机扫码登录小红书' };
}

/* ---------------- 搜索 ---------------- */

async function collectNotes(page: Page, limit: number): Promise<XhsNote[]> {
  return page.evaluate((max: number) => {
    interface ElLike {
      textContent: string | null;
      getAttribute(name: string): string | null;
      querySelector(selector: string): ElLike | null;
      matches(selector: string): boolean;
      currentSrc?: string;
      src?: string;
    }
    const doc = (globalThis as unknown as { document: { querySelectorAll(sel: string): ArrayLike<ElLike> } }).document;
    const out: { id: string; noteUrl: string; thumbUrl: string; title: string }[] = [];
    const seen = new Set<string>();
    const cards: ElLike[] = Array.from(doc.querySelectorAll('section.note-item, div.note-item'));
    const scopes: ElLike[] = cards.length ? cards : Array.from(doc.querySelectorAll('a[href*="/explore/"]'));
    for (const node of scopes) {
      if (out.length >= max) break;
      const anchor = node.matches('a[href*="/explore/"]') ? node : node.querySelector('a[href*="/explore/"]');
      if (!anchor) continue;
      const m = (anchor.getAttribute('href') ?? '').match(/\/explore\/([0-9a-zA-Z]+)/);
      if (!m || seen.has(m[1])) continue;
      const img = node.querySelector('img');
      let src = img ? img.currentSrc || img.src || img.getAttribute('data-src') || '' : '';
      if (!src || src.startsWith('data:')) {
        const dataSrc = img?.getAttribute('data-src') ?? '';
        src = dataSrc.startsWith('data:') ? '' : dataSrc;
      }
      if (!src || src.startsWith('data:')) continue;
      seen.add(m[1]);
      const title = (node.querySelector('a.title, .title, span.title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      out.push({ id: m[1], noteUrl: `https://www.xiaohongshu.com/explore/${m[1]}`, thumbUrl: src, title });
    }
    return out;
  }, limit);
}

async function runSearchOnce(headless: boolean, kw: string, limit: number): Promise<{ notes: XhsNote[] | null; block: string | null }> {
  const ctx = await launchBrowser(headless);
  try {
    const cookies = await ctx.cookies('https://www.xiaohongshu.com').catch(() => []);
    if (!cookies.some((c) => c.name === 'web_session' && c.value)) {
      throw new RefSearchError('LOGIN_REQUIRED', '尚未登录小红书，请先扫码登录', 401);
    }
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(buildSearchUrl(kw), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector('section.note-item, div.note-item, a[href*="/explore/"]', { timeout: 12_000 }).catch(() => {});
    const block = await securityBlocked(page);
    if (block) return { notes: null, block };
    let notes = await collectNotes(page, limit);
    if (notes.length === 0 && (await loginModalCount(page)) > 0) {
      throw new RefSearchError('LOGIN_REQUIRED', '登录状态无效，请重新扫码登录', 401);
    }
    for (let i = 0; i < 2 && notes.length < limit; i++) {
      await page.mouse.wheel(0, 1600).catch(() => {});
      await page.waitForTimeout(800);
      notes = await collectNotes(page, limit);
    }
    if (notes.length === 0) {
      if ((await loginModalCount(page)) > 0) {
        throw new RefSearchError('LOGIN_REQUIRED', '登录状态无效，请重新扫码登录', 401);
      }
      throw new RefSearchError('NO_RESULTS', '没有搜到相关内容，换个关键词再试', 404);
    }
    return { notes, block: null };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function xhsSearch(keyword: string, limit = 24): Promise<XhsNote[]> {
  const kw = keyword.trim();
  if (!kw) throw new RefSearchError('EMPTY_KEYWORD', '请输入搜索关键词');
  if (loginState === 'waiting') throw new RefSearchError('LOGIN_PENDING', '登录窗口还开着，请先完成扫码登录', 409);
  return runExclusive(async () => {
    try {
      const forceHeadful = process.env.FXDESK_REFSEARCH_HEADFUL === '1';
      if (!headlessBlocked && !forceHeadful) {
        const first = await runSearchOnce(true, kw, limit);
        if (first.notes) return first.notes;
        headlessBlocked = true;
        logLine('warn', `小红书 headless 搜索被风控拦截，切换可见窗口重试：${first.block ?? ''}`);
      }
      const second = await runSearchOnce(false, kw, limit);
      if (second.notes) return second.notes;
      throw new RefSearchError('SECURITY_BLOCK', second.block ?? '小红书安全限制，请切换网络后重试', 403);
    } catch (e) {
      if (e instanceof RefSearchError && e.code === 'LOGIN_REQUIRED') loginState = 'idle';
      throw e;
    }
  });
}

/* ---------------- 图片下载 ---------------- */

export async function fetchXhsImage(raw: string): Promise<Buffer> {
  if (!isAllowedImageUrl(raw)) throw new RefSearchError('BAD_IMAGE_URL', '仅支持小红书图片链接');
  const candidates = [upgradeCdnUrl(raw), raw].filter((u, i, arr) => arr.indexOf(u) === i);
  let lastError = '';
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Referer: XHS_REFERER, 'User-Agent': LATEST_CHROME_UA },
        redirect: 'follow',
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        lastError = '返回空内容';
        continue;
      }
      if (buf.length > 50 * 1024 * 1024) {
        lastError = '图片超过 50 MB';
        continue;
      }
      return buf;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new RefSearchError('IMAGE_FETCH_FAILED', `图片下载失败${lastError ? `：${lastError}` : ''}`, 502);
}

export async function fetchXhsThumb(raw: string): Promise<{ buf: Buffer; contentType: string }> {
  if (!isAllowedImageUrl(raw)) throw new RefSearchError('BAD_IMAGE_URL', '仅支持小红书图片链接');
  const res = await fetch(raw, {
    headers: { Referer: XHS_REFERER, 'User-Agent': LATEST_CHROME_UA },
    redirect: 'follow',
  });
  if (!res.ok) throw new RefSearchError('IMAGE_FETCH_FAILED', `缩略图下载失败：HTTP ${res.status}`, 502);
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new RefSearchError('IMAGE_FETCH_FAILED', '返回内容不是图片', 502);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new RefSearchError('IMAGE_TOO_LARGE', '缩略图超过 20 MB', 502);
  return { buf, contentType };
}
