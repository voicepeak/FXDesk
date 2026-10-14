// Integration checks use a temporary workspace and local server; no customer data or paid API calls.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-selection-ui-'));
const port = 33219;
const APP = `http://127.0.0.1:${port}`;
const shots = path.join(root, '验收截图');
fs.mkdirSync(shots, { recursive: true });
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], { cwd: root, windowsHide: true, env: { ...process.env, FXDESK_WORKSPACE: temp, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (b) => { logs += b; });
child.stderr.on('data', (b) => { logs += b; });
let browser;
let page;
const json = async (pathname, init) => {
  const response = await fetch(APP + pathname, init);
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
};
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(APP + '/api/jobs')).ok) break; } catch { /* starting */ }
    if (i === 99) throw new Error('Temporary server did not start: ' + logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const original = fs.readFileSync(path.join(root, 'workspace/demo/demo-photo.jpg'));
  const form = new FormData(); form.append('name', '框选与参考图验收'); form.append('original', new Blob([original], { type: 'image/jpeg' }), '原图.jpg');
  const job = await json('/api/jobs', { method: 'POST', body: form });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1550, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/balance', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 0, totalGranted: 0, remainQuota: 0, totalUsed: 0 }) }));
  await page.goto(APP + `/#/job/${job.id}`);
  await page.waitForSelector('.canvas-wrap canvas');
  await page.waitForFunction(() => document.querySelector('.zoom-label')?.textContent !== '100%');
  const imagePoint = async (x, y) => {
    const rect = await page.locator('.canvas-wrap').boundingBox();
    const scale = Math.min(rect.width / job.width, rect.height / job.height) * 0.92;
    return { x: rect.x + (rect.width - job.width * scale) / 2 + x * job.width * scale, y: rect.y + (rect.height - job.height * scale) / 2 + y * job.height * scale };
  };
  const move = async (x, y, steps = 1) => { const p = await imagePoint(x, y); await page.mouse.move(p.x, p.y, { steps }); };
  const click = async (x, y) => { const p = await imagePoint(x, y); await page.mouse.click(p.x, p.y); };
  const getRegions = async () => (await json(`/api/jobs/${job.id}`)).regions;
  const waitCount = async (n) => {
    await page.waitForFunction((count) => document.querySelectorAll('.editor-col-right .region-color-dot').length === count, n);
    for (let i = 0; i < 60; i++) { if ((await getRegions()).length === n) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`Expected ${n} saved regions`);
  };
  const drag = async (tool, a, b) => {
    await page.getByRole('button', { name: tool, exact: true }).click();
    await move(...a); await page.mouse.down(); await move(...b, 10); await page.mouse.up();
  };

  await drag('▭ 矩形框选', [0.13, 0.14], [0.40, 0.39]); await waitCount(1);
  // The entire interior must have zero overlay alpha, even for the selected region.
  const center = await imagePoint(0.26, 0.26);
  const alpha = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelectorAll('.canvas-wrap canvas')[1];
    const b = canvas.getBoundingClientRect();
    return canvas.getContext('2d').getImageData(Math.floor((x - b.x) * canvas.width / b.width), Math.floor((y - b.y) * canvas.height / b.height), 1, 1).data[3];
  }, center);
  assert.equal(alpha, 0, 'Selected region interior must not cover the photograph');
  console.log('[PASS] 矩形选区内部完全透明');

  await drag('◯ 椭圆', [0.52, 0.14], [0.85, 0.4]); await waitCount(2);
  await page.getByRole('button', { name: '⬡ 多边形', exact: true }).click();
  await click(0.12, 0.57); await click(0.38, 0.56); await click(0.23, 0.84);
  await page.keyboard.press('Enter'); await waitCount(3);
  await page.getByRole('button', { name: '⌁ 自由套索', exact: true }).click();
  await move(0.54, 0.56); await page.mouse.down();
  for (const point of [[0.7, 0.54], [0.86, 0.66], [0.79, 0.83], [0.57, 0.79], [0.54, 0.56]]) await move(...point, 5);
  await page.mouse.up(); await waitCount(4);
  let regions = await getRegions();
  assert.deepEqual(regions.map((r) => r.bbox.shape), ['rect', 'ellipse', 'polygon', 'lasso']);
  assert.equal(regions[2].bbox.points.length, 3); assert(regions[3].bbox.points.length > 10);
  await page.reload(); await page.waitForSelector('.canvas-wrap canvas'); await waitCount(4);
  assert.deepEqual((await getRegions()).map((r) => r.bbox), regions.map((r) => r.bbox));
  console.log('[PASS] 矩形、椭圆、多边形、套索保存与重载');

  // Transparent interiors remain selectable and movable.
  await click(0.23, 0.67); await move(0.23, 0.67); await page.mouse.down(); await move(0.27, 0.68, 10); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.editor-toolbar')?.textContent.includes('已保存'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const moved = (await getRegions())[2].bbox;
  assert(moved.x1 > regions[2].bbox.x1); assert.deepEqual(moved.points, regions[2].bbox.points);
  console.log('[PASS] 透明多边形可选中、拖动且保留轮廓');

  await move(moved.x2 / job.width, moved.y2 / job.height);
  await page.mouse.down(); await move(moved.x2 / job.width + 0.04, moved.y2 / job.height + 0.04, 10); await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const resized = (await getRegions())[2].bbox;
  assert(resized.x2 - resized.x1 > moved.x2 - moved.x1); assert.deepEqual(resized.points, moved.points);
  const inside = await imagePoint(0.28, 0.7);
  await page.mouse.click(inside.x, inside.y, { button: 'right' });
  await page.getByRole('button', { name: '复制区域', exact: true }).click(); await waitCount(5);
  const copied = (await getRegions())[4].bbox;
  assert.equal(copied.shape, 'polygon'); assert.deepEqual(copied.points, resized.points);
  await page.getByRole('button', { name: '删除所选', exact: true }).click(); await waitCount(4);
  console.log('[PASS] 多边形缩放、复制和删除保留正确形状');

  // Esc cancels the draft without deleting the previously selected region.
  await page.getByRole('button', { name: '⬡ 多边形', exact: true }).click();
  await click(0.2, 0.2); await click(0.4, 0.3); await page.keyboard.press('Escape'); await waitCount(4);
  console.log('[PASS] Esc 取消绘制不误删已有选区');

  const uploadInput = page.getByLabel('参考图文件');
  const gif = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#225588' } }).gif().toBuffer();
  await uploadInput.setInputFiles([{ name: '参考一.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(root, 'workspace/demo/demo-sword.png')) }, { name: '参考二.gif', mimeType: 'image/gif', buffer: gif }]);
  await page.waitForFunction(() => document.querySelectorAll('.material-item').length === 2);
  const picker = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '上传参考图', exact: true }).click();
  await (await picker).setFiles({ name: '点击上传.png', mimeType: 'image/png', buffer: gif });
  await page.waitForFunction(() => document.querySelectorAll('.material-item').length === 3);
  console.log('[PASS] 点击打开文件选择器、批量上传、GIF 解码');

  await page.locator('.editor-col-left .panel-scroll').evaluate((element, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '拖拽参考.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, gif.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('.material-item').length === 4);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '粘贴参考.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, gif.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('.material-item').length === 5);
  await page.waitForFunction(() => [...document.querySelectorAll('.material-thumb')].every((img) => img.complete && img.naturalWidth > 0));
  assert.deepEqual((await json(`/api/jobs/${job.id}`)).materials.map((m) => m.orderIndex), [1, 2, 3, 4, 5]);
  console.log('[PASS] 拖拽和粘贴上传、缩略图与参考图编号');
  await uploadInput.setInputFiles({ name: '损坏.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.getByText(/无法读取参考图/).waitFor();
  assert.equal(await page.locator('.material-item').count(), 5);
  await page.getByRole('button', { name: '⬚ 选择', exact: true }).click();
  while (await page.locator('.toast').count()) await page.locator('.toast').first().click();
  await page.screenshot({ path: path.join(shots, 'selection-upload-fixed.png') });
  assert.deepEqual(errors, []);
  console.log('[PASS] 错误反馈与全部浏览器操作；无页面运行错误');
} catch (error) {
  await page?.screenshot({ path: path.join(shots, 'selection-upload-debug.png') });
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('fxdesk-selection-ui-')) {
    // Windows releases SQLite handles asynchronously after process exit.
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
