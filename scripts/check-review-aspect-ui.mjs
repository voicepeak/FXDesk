// Read-only verification of an existing job; repair submission is intercepted locally.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobId = process.env.FXDESK_UI_JOB ?? '20261014-02';
const shots = path.join(root, '验收截图');
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];

async function checkImages(page, fitted = true) {
  await page.waitForFunction((fit) => [...document.querySelectorAll('.compare-img')].length === 2 && [...document.querySelectorAll('.compare-img')].every((im) => {
    const r = im.getBoundingClientRect();
    const p = im.parentElement.getBoundingClientRect();
    return im.complete && im.naturalWidth && getComputedStyle(im).visibility === 'visible' && r.width > 0 && Math.abs((r.width / r.height) / (im.naturalWidth / im.naturalHeight) - 1) < 0.0001 && (!fit || (r.left >= p.left && r.top >= p.top && r.right <= p.right && r.bottom <= p.bottom));
  }), fitted);
  const images = await page.locator('.compare-img').evaluateAll((imgs) => imgs.map((im) => {
    const r = im.getBoundingClientRect();
    const p = im.parentElement.getBoundingClientRect();
    return { natural: [im.naturalWidth, im.naturalHeight], display: [r.width, r.height], inside: r.left >= p.left && r.top >= p.top && r.right <= p.right && r.bottom <= p.bottom };
  }));
  for (const im of images) {
    assert(Math.abs((im.display[0] / im.display[1]) / (im.natural[0] / im.natural[1]) - 1) < 0.0001, '预览必须保持图片自身比例');
    if (fitted) assert(im.inside, '适配后必须完整显示图片');
  }
  return images;
}

try {
  for (const app of ['http://localhost:5173', 'http://127.0.0.1:3210']) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', (error) => errors.push(error.message));
    let submitted;
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/api/balance') return route.fulfill({ json: { balance: 0 } });
      if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (req.method() === 'POST' && url.pathname.endsWith('/repair')) {
        submitted = req.postDataJSON();
        return route.fulfill({ json: { id: 'test-intercepted', seq: 3 } });
      }
      assert.equal(req.method(), 'GET', `禁止实际写入：${url.pathname}`);
      return route.continue();
    });
    await page.goto(`${app}/#/job/${jobId}/review`);
    await page.locator('.run-thumb-card').filter({ has: page.getByText('v2', { exact: true }) }).click();
    await page.waitForFunction(() => document.querySelectorAll('.compare-img')[1]?.naturalHeight === 6116);
    const fitted = await checkImages(page);
    assert.deepEqual(fitted[1].natural, [2816, 6116]);
    await page.getByRole('button', { name: '1:1', exact: true }).click();
    const native = await checkImages(page, false);
    native.forEach((im) => im.display.forEach((dimension, i) => assert(Math.abs(dimension - im.natural[i]) < 0.01)));
    await page.getByRole('button', { name: '适配窗口', exact: true }).click();
    await page.locator('.run-thumb-card').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.compare-img')[1]?.naturalHeight === 4992);
    assert.deepEqual((await checkImages(page))[1].natural, [3456, 4992]);
    await page.locator('.run-thumb-card').filter({ has: page.getByText('v2', { exact: true }) }).click();
    await page.waitForFunction(() => document.querySelectorAll('.compare-img')[1]?.naturalHeight === 6116);
    await checkImages(page);

    const panes = page.locator('.compare-pane');
    await panes.last().hover();
    await page.mouse.wheel(0, -180);
    await checkImages(page, false);
    const box = await panes.last().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20);
    await page.mouse.up();
    await checkImages(page, false);

    await page.getByRole('button', { name: '定点重修', exact: false }).click();
    const overlay = page.locator('.repair-overlay');
    const area = await overlay.boundingBox();
    await page.mouse.move(area.x + area.width * 0.2, area.y + area.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.5);
    await page.mouse.up();
    await page.getByPlaceholder('例：该区域手部结构错误，参考原图手型修正手指结构，保持光影一致').fill('仅验证坐标，不调用生成');
    await page.getByRole('button', { name: '提交重修', exact: false }).click();
    assert(submitted, '必须拦截重修请求');
    const bbox = submitted.regions[0].bbox;
    for (const [key, expected] of Object.entries({ x1: 2816 * 0.2, y1: 6116 * 0.3, x2: 2816 * 0.4, y2: 6116 * 0.5 })) {
      assert(Math.abs(bbox[key] - expected) < 12, `${key} 应使用结果图实际坐标`);
    }
    await page.getByRole('button', { name: '滑块对比', exact: true }).click();
    await page.getByRole('button', { name: '1:1', exact: true }).click();
    const afterWipe = await checkImages(page, false);
    assert(Math.abs(afterWipe[1].display[1] - 6116) < 0.01);
    await page.getByRole('button', { name: '适配窗口', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await checkImages(page);
    while (await page.locator('.toast').count()) await page.locator('.toast').first().click();
    if (app.includes('5173')) await page.screenshot({ path: path.join(shots, 'review-aspect-fixed.png') });
    await page.setViewportSize({ width: 690, height: 900 });
    await checkImages(page);
    await page.close();
    console.log(`[PASS] ${app}: 原比例、适配、1:1、版本切换、缩放拖动、圈选坐标、窗口调整`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
