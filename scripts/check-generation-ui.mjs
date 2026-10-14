// Read-only UI verification against an existing generated job. All generation states and reveal actions are mocked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobId = process.env.FXDESK_UI_JOB ?? '20261014-01';
const API = 'http://127.0.0.1:3210';
const detail = await fetch(`${API}/api/jobs/${jobId}`).then((r) => r.json());
assert(detail.job?.finalRunId, '需要一笔已经生成的客单用于只读检查');
const runId = detail.job.finalRunId;
const location = await fetch(`${API}/api/runs/${runId}/location`).then((r) => r.json());
const originalJobs = await fetch(`${API}/api/jobs`).then((r) => r.json());
const settings = await fetch(`${API}/api/settings`).then((r) => r.json());
const browser = await chromium.launch({ headless: true });
const errors = [];
let state = 'done';
let reveals = 0;
const queue = () => ({ concurrency: 4, pending: [], active: state === 'done' ? [] : [{ jobId, runId, name: detail.job.name, thumb: detail.job.originalUrl, stage: state === 'retry' ? 'retrying' : 'generating', elapsed: 150000, startedAt: Date.now() - 150000, cost: 0, imageSize: '4K', timeoutSec: 600, attempt: 1, message: state === 'retry' ? '远端限流，等待后重试' : '等待远端生成结果', ...(state === 'retry' ? { retryAt: Date.now() + 20000 } : {}) }], todayCost: 0.1, monthlyCost: 0.1, mock: false });
try {
  for (const APP of ['http://localhost:5173', API]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.pathname === '/api/balance') return json({ balance: 0, totalGranted: 0, remainQuota: 0, totalUsed: 0 });
      if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (url.pathname === '/api/queue') return json(queue());
      if (url.pathname === '/api/jobs') return json({ jobs: originalJobs.jobs.map((j) => j.id === jobId && state !== 'done' ? { ...j, status: 'generating' } : j) });
      if (url.pathname === `/api/runs/${runId}/reveal`) { assert.equal(route.request().method(), 'POST'); reveals++; return json({ ok: true, ...location }); }
      assert.equal(route.request().method(), 'GET', `测试禁止写入：${url.pathname}`);
      return route.continue();
    });
    state = 'done';
    await page.goto(`${APP}/#/job/${jobId}/review`);
    await page.getByRole('button', { name: '查看生成文件位置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '生成文件位置' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox').inputValue(), location.filePath);
    await dialog.getByRole('button', { name: '打开文件位置', exact: true }).click();
    await page.getByText('已打开资源管理器并选中生成文件', { exact: true }).waitFor();
    fs.mkdirSync(path.join(root, '验收截图'), { recursive: true });
    if (APP.includes('5173')) await page.screenshot({ path: path.join(root, '验收截图', 'generation-location.png') });
    await dialog.getByRole('button', { name: '关闭弹窗' }).click();
    await page.goto(`${APP}/#/settings`);
    await page.getByText('并行生成数（1~4）', { exact: true }).waitFor();
    assert.equal(await page.locator('.form-row').filter({ hasText: '并行生成数（1~4）' }).locator('input').inputValue(), String(settings.queueConcurrency));
    assert.equal(await page.locator('.form-row').filter({ hasText: '生成等待上限（秒）' }).locator('input').inputValue(), String(settings.runTimeoutSec));
    if (APP.includes('5173')) await page.screenshot({ path: path.join(root, '验收截图', 'generation-settings.png') });
    state = 'slow';
    await page.goto(`${APP}/#/job/${jobId}`);
    await page.reload();
    await page.getByText('远端生成等待较久', { exact: true }).waitFor();
    await page.getByText('最长等待 10 分钟', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始生成', exact: true }).isEnabled(), false);
    if (APP.includes('5173')) await page.screenshot({ path: path.join(root, '验收截图', 'generation-slow.png') });
    state = 'retry'; await page.reload();
    await page.locator('.generation-status-title').getByText(/远端限流/).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始生成', exact: true }).isEnabled(), false);
    if (APP.includes('5173')) await page.screenshot({ path: path.join(root, '验收截图', 'generation-retry.png') });
    await page.setViewportSize({ width: 690, height: 900 });
    state = 'done'; await page.goto(`${APP}/#/job/${jobId}/review`); await page.reload();
    await page.getByRole('button', { name: '查看生成文件位置', exact: true }).click();
    await page.getByRole('dialog', { name: '生成文件位置' }).waitFor();
    if (APP.includes('5173')) await page.screenshot({ path: path.join(root, '验收截图', 'generation-location-mobile.png') });
    await context.close();
    console.log(`PASS ${APP}: 文件路径、定位按钮、并发设置、慢生成、限流状态与窄屏`);
  }
  assert.equal(reveals, 2);
  assert.deepEqual(errors, []);
  console.log('PASS 无页面运行错误；未调用付费生成，未改动客单或结果文件');
} finally { await browser.close(); }
