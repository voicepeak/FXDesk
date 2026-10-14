/**
 * FXDesk 浏览器 UI 验收脚本（Playwright，PRD §12.1 的界面层验收）。
 * 前置：
 *   1) npm run setup（确保 workspace/demo 演示素材与种子素材库存在）
 *   2) npm run dev   （后端 3210 + 前端 5173 均在运行）
 * 用法：node scripts/ui-acceptance.mjs
 * 产物：验收截图/*.png（13 张关键步骤）、ui-acceptance-results.json（机器可读结果）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const APP = 'http://localhost:5173';
const API = 'http://127.0.0.1:3210';
const DEMO = path.join(root, 'workspace', 'demo');
const SHOTS = path.join(root, '验收截图');
/* 每次运行使用唯一客单名，避免重复验收时历史成果重名导致选择器歧义 */
const JOB_NAME = `UI验收-${String(Date.now()).slice(-5)}`;
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];
let shotN = 0;
const shot = async (page, name) => {
  shotN++;
  await page.screenshot({ path: path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`) });
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail ?? '' });
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    console.error(`[FAIL] ${name} — ${e instanceof Error ? e.message : e}`);
  }
};

async function api(pathname, init) {
  const res = await fetch(API + pathname, init);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ---------- 前置检查 ---------- */
let ok = true;
try {
  const r = await fetch(API + '/api/queue');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch {
  console.error(`[前置失败] 后端未响应 ${API}。请先运行：npm run dev`);
  ok = false;
}
try {
  const r = await fetch(APP);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch {
  console.error(`[前置失败] 前端未响应 ${APP}。请先运行：npm run dev`);
  ok = false;
}
if (!fs.existsSync(path.join(DEMO, 'demo-photo.jpg'))) {
  console.error('[前置失败] 缺少演示素材 workspace/demo。请先运行：npm run setup（或 npm run seed）');
  ok = false;
}
if (!ok) process.exit(1);

{
  const lib = await api('/api/library/items?q=' + encodeURIComponent('闪电'));
  const has = [...(lib.json?.available ?? []), ...(lib.json?.history ?? [])].some((i) => i.title === '闪电');
  if (!has) {
    console.error('[前置失败] 素材库缺少种子素材「闪电」。请先运行：npm run seed');
    process.exit(1);
  }
}

/* ---------- 开启模拟模式（离线可验收完整 UI 流程） ---------- */
await api('/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mockApi: true, notifySound: false, notifyToast: false }),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on('dialog', (d) => d.accept());
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

let jobId = null;
try {
  /* ---------- 首页 ---------- */
  await check('UI-1 首页加载（客单列表 + 顶栏 + 余额）', async () => {
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.waitForSelector('.jobs-page', { timeout: 15000 });
    await page.waitForSelector('.jobs-toolbar', { timeout: 15000 });
    const balance = await page.textContent('.balance-chip');
    if (!balance || !/¥/.test(balance)) throw new Error('余额未显示: ' + balance);
    await shot(page, 'jobs');
    return `余额条「${balance.replace(/\s+/g, ' ').trim()}」`;
  });

  /* ---------- 新建客单 ---------- */
  await check('UI-2 新建客单（上传原图 → 进入编辑器）', async () => {
    await page.click('button:has-text("新建客单")');
    await page.waitForSelector('.modal');
    await page.fill('.modal input.input', JOB_NAME);
    const input = await page.$('.modal input[type=file]');
    await input.setInputFiles(path.join(DEMO, 'demo-photo.jpg'));
    await page.click('.modal button:has-text("创建并进入编辑")');
    await page.waitForSelector('.editor', { timeout: 20000 });
    await page.waitForSelector('.canvas-wrap canvas', { timeout: 20000 });
    await shot(page, 'editor');
    return '三栏编辑器 + Konva 画布已渲染';
  });

  /* ---------- 素材 ---------- */
  await check('UI-3 上传客户素材（剑）→ 参考图1', async () => {
    const input = await page.$('.editor-col-left input[type=file]');
    await input.setInputFiles(path.join(DEMO, 'demo-sword.png'));
    await page.waitForSelector('.material-item', { timeout: 15000 });
    await page.waitForFunction(() => document.body.textContent.includes('参考图1'), { timeout: 15000 });
    return '素材项出现，编号 参考图1';
  });

  await check('UI-4 从素材库选择（闪电）→ 参考图2', async () => {
    await page.click('button:has-text("从素材库选择")');
    await page.waitForSelector('.picker-card', { timeout: 15000 });
    await page.click('.picker-card:has-text("闪电")');
    await page.waitForFunction(() => document.body.textContent.includes('参考图2'), { timeout: 15000 });
    const items = await page.$$('.material-item');
    if (items.length !== 2) throw new Error(`素材数=${items.length}`);
    await shot(page, 'materials');
    return '2 个素材（客户剑 + 库闪电）';
  });

  /* ---------- 画布框选 ---------- */
  await check('UI-5 画布框选创建区域（红①/黄②，颜色循环）', async () => {
    await page.keyboard.press('r');
    const box = await page.locator('.canvas-wrap').boundingBox();
    const drag = async (x1, y1, x2, y2) => {
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 12 });
      await page.mouse.up();
    };
    await drag(0.34, 0.55, 0.58, 0.75);
    await page.waitForFunction(() => document.body.textContent.includes('第1区'), { timeout: 10000 });
    await page.keyboard.press('r');
    await drag(0.25, 0.3, 0.7, 0.85);
    await page.waitForFunction(() => document.body.textContent.includes('第' + '2' + '区'), { timeout: 10000 });
    const text = await page.textContent('.editor-col-right');
    if (!text.includes('红框 第1区') || !text.includes('黄框 第2区')) throw new Error('区域条目颜色/编号不符');
    await page.keyboard.press('Escape');
    await shot(page, 'regions');
    return '红框 第1区 / 黄框 第2区 已自动出现在总览';
  });

  /* ---------- 指令与全局 ---------- */
  await check('UI-6 填写区域指令 + 插入参考图 + 全局指令 + 最终提示词预览', async () => {
    const areas = await page.$$('.editor-col-right textarea');
    await areas[0].fill('在手中添加参考图1的剑，握持关系自然，剑身受光与环境光一致');
    await areas[1].fill('身体周围添加参考图2的闪电特效，光效与轮廓光方向一致');
    // 插入参考图下拉（第1区）
    const selects = await page.$$('.editor-col-right select');
    await selects[0].selectOption({ index: 1 });
    await page.waitForTimeout(900);
    // 全局
    const areas2 = await page.$$('.editor-col-right textarea');
    await areas2[2].fill('将背景整体替换为雨夜街道，霓虹反光与人物轮廓光方向一致');
    await page.waitForTimeout(900);
    await page.click('button:has-text("查看最终提示词")');
    await page.waitForSelector('.final-prompt', { timeout: 10000 });
    const final = await page.textContent('.final-prompt');
    if (!final.includes('【红框 第1区】')) throw new Error('最终提示词缺区域1');
    if (!final.includes('【全局修改】')) throw new Error('最终提示词缺全局块');
    if (!final.includes('移除画面上所有彩色框标记')) throw new Error('缺收尾块（标记移除）');
    if (!/画面(左侧|右侧|中央|上部|下部|中部)/.test(final)) throw new Error('缺方位描述');
    // 参考图 token 气泡
    const hasChip = await page.$('.ref-chip-row .chip');
    if (!hasChip) throw new Error('参考图气泡未出现');
    await shot(page, 'prompt');
    return `最终提示词 ${final.length} 字，含区域/全局/收尾/方位描述`;
  });

  /* ---------- 生成 ---------- */
  await check('UI-7 开始生成 → 任务栏进度（排队/生成/质检）', async () => {
    await page.click('button:has-text("开始生成")');
    await page.waitForFunction(() => document.body.textContent.includes('任务栏'), { timeout: 10000 });
    await page.waitForFunction(
      () => /排队中|生成中|质检中/.test(document.querySelector('.taskbar')?.textContent ?? ''),
      { timeout: 20000 }
    );
    await shot(page, 'taskbar-running');
    return '任务卡片出现（排队→生成→质检）';
  });

  await check('UI-8 完成后任务栏出卡片，客单进入「待审核」', async () => {
    for (let i = 0; i < 120; i++) {
      const r = await api('/api/jobs');
      const job = r.json?.jobs?.find((x) => x.name === JOB_NAME);
      if (job && (job.status === 'review' || job.status === 'failed')) {
        jobId = job.id;
        if (job.status === 'failed') throw new Error('生成失败：' + job.id);
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!jobId) throw new Error('等待 review 超时');
    await page.goto(APP + '/#/jobs', { waitUntil: 'networkidle' });
    await page.waitForFunction((name) => document.body.textContent.includes(name), JOB_NAME, { timeout: 15000 });
    await page.waitForFunction(() => document.body.textContent.includes('待审核'), { timeout: 15000 });
    await shot(page, 'jobs-review');
    return `job=${jobId} → review`;
  });

  /* ---------- 审核 ---------- */
  await check('UI-9 审核界面（对比图 + QC 横幅 + Run 条）', async () => {
    await page.goto(APP + `/#/job/${jobId}/review`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.review-banner', { timeout: 20000 });
    await page.waitForSelector('.compare-img', { timeout: 20000 });
    await page.waitForSelector('.run-strip .run-thumb-card', { timeout: 20000 });
    const banner = await page.textContent('.review-banner');
    if (!banner.includes('构图')) throw new Error('QC 横幅缺构图结论');
    if (!/身份/.test(banner)) throw new Error('QC 横幅缺身份结论');
    await page.click('button:has-text("滑块对比")');
    await page.waitForSelector('.wipe-slider', { timeout: 10000 });
    await page.click('button:has-text("退出滑块对比")');
    await shot(page, 'review');
    return '横幅含身份/构图结论，滑块对比可用';
  });

  await check('UI-10 定点重修（在结果图上画问题区）', async () => {
    await page.click('button:has-text("定点重修")');
    await page.waitForTimeout(400);
    const pane = await page.locator('.compare-pane').nth(1).boundingBox();
    await page.mouse.move(pane.x + pane.width * 0.35, pane.y + pane.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(pane.x + pane.width * 0.55, pane.y + pane.height * 0.6, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => document.body.textContent.includes('问题区 1'), { timeout: 10000 });
    await shot(page, 'repair-draw');
    await page.click('button:has-text("退出定点重修")');
    return '问题区绘制框出现';
  });

  await check('UI-11 通过交付 → 已交付 + 归档提示', async () => {
    await page.click('button:has-text("通过交付")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('归档')), { timeout: 25000 });
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => t.includes('归档')) ?? '');
    await shot(page, 'delivered');
    const j = await api(`/api/jobs/${jobId}`);
    if (j.json?.job?.status !== 'delivered') throw new Error(`客单状态=${j.json?.job?.status}`);
    return `${(toast ?? '').trim()}（状态已确认 delivered）`;
  });

  /* ---------- 素材库 ---------- */
  await check('UI-12 素材库：历史成果 + 搜索 + 提取净版', async () => {
    await page.goto(APP + '/#/library', { waitUntil: 'networkidle' });
    await page.click('button:has-text("历史成果")');
    await page.waitForSelector('.history-row', { timeout: 20000 });
    const rows = await page.textContent('.library-page');
    if (!rows.includes(JOB_NAME)) throw new Error(`历史成果缺 ${JOB_NAME}`);
    await page.fill('.search-input', '闪电');
    await page.waitForTimeout(700);
    await page.waitForFunction((name) => document.body.textContent.includes(name), JOB_NAME, { timeout: 10000 });
    const searchHit = await page.locator(`.history-row:has-text("${JOB_NAME}")`).count();
    if (!searchHit) throw new Error('搜索「闪电」未命中');
    await shot(page, 'library-search');
    await page.fill('.search-input', '');
    await page.waitForTimeout(600);
    await page.locator(`.history-row:has-text("${JOB_NAME}") button:has-text("提取净版")`).click();
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("开始提取")');
    await page.waitForFunction(() => document.body.textContent.includes('净版提取中'), { timeout: 10000 });
    await shot(page, 'plate-start');
    return '历史成果存在、搜索命中、净版提取已触发';
  });

  /* ---------- 设置页 ---------- */
  await check('UI-13 设置页（分组字段 + 模板编辑器 + 测试连接）', async () => {
    await page.goto(APP + '/#/settings', { waitUntil: 'networkidle' });
    await page.waitForSelector('.settings-page', { timeout: 15000 });
    const text = await page.textContent('.settings-page');
    for (const kw of ['API Key', 'Base URL', '模型 ID', '输出尺寸', '身份通过阈值', '系统块', '净版提取指令', '清空回收站']) {
      if (!text.includes(kw)) throw new Error(`缺少设置项：${kw}`);
    }
    await page.click('button:has-text("测试连接")');
    await page.waitForSelector('.settings-msg.ok', { timeout: 15000 });
    const msg = await page.textContent('.settings-msg.ok');
    await shot(page, 'settings');
    return `测试连接：${msg.trim()}`;
  });

  /* ---------- 控制台错误 ---------- */
  await check('UI-14 无前端运行时错误', async () => {
    const errs = consoleErrors.filter((e) => !/favicon|React DevTools|Download the React/i.test(e));
    if (errs.length) throw new Error(`控制台错误 ${errs.length} 条：\n${errs.slice(0, 5).join('\n')}`);
    return '控制台无 error';
  });
} finally {
  await browser.close();
  /* 恢复设置（关闭模拟 / 通知恢复默认开），保持验收后环境干净 */
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mockApi: false, apiKey: '', baseUrl: 'https://api.momoapi.icu', notifySound: true, notifyToast: true }),
  }).catch(() => undefined);
}

const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(
  path.join(root, 'ui-acceptance-results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), mode: 'mock（离线模拟，UI 全流程；真实 Key 条目见 ACCEPTANCE.md）', passed, total: results.length, results, consoleErrors }, null, 2),
  'utf8'
);
console.log(`\n== UI 验收：${passed}/${results.length} 通过 ==`);
console.log('明细已写入 ui-acceptance-results.json，截图见 验收截图/');
process.exit(passed === results.length ? 0 : 1);
