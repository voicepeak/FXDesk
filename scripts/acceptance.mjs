/**
 * FXDesk 端到端验收脚本（PRD §12.1）
 * 用法：node scripts/acceptance.mjs
 * 可选环境变量：
 *   FXDESK_ACCEPT_PORT  验收服务器端口（默认 3210）
 *   FXDESK_WORKSPACE    独立工作区目录（默认仓库 workspace/；建议指向临时目录，避免污染真实工作区，
 *                       也避免与正在运行的 dev 服务共用同一数据库互相干扰）
 * 说明：验收在「离线模拟模式」下跑通完整管线（无真 Key 亦可验收全部流程）；
 *       真实 API 的验收步骤见 ACCEPTANCE.md 中标 [需真实 Key] 的条目。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import Database from 'better-sqlite3';

const PORT = Number(process.env.FXDESK_ACCEPT_PORT || 3210);

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BASE = `http://127.0.0.1:${PORT}`;
const WS = process.env.FXDESK_WORKSPACE ? path.resolve(process.env.FXDESK_WORKSPACE) : path.join(root, 'workspace');
fs.mkdirSync(WS, { recursive: true });
process.env.FXDESK_WORKSPACE = WS;
const results = [];
let server = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, form) {
  const init = { method };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

function fileForm(fieldName, filePath) {
  const fd = new FormData();
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  fd.append(fieldName, new Blob([new Uint8Array(buf)], { type: mime }), path.basename(filePath));
  return fd;
}

function isPortInUse(port = PORT) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

async function assertPortFree() {
  if (await isPortInUse()) {
    console.error(
      `\n[验收中止] 端口 ${PORT} 已被占用：可能有旧的服务/dev 进程在运行。\n` +
        `请先关闭占用进程（例如结束 npm run dev 后重试；PowerShell：Get-NetTCPConnection -LocalPort ${PORT} | Select OwningProcess），\n` +
        `否则验收会误打到旧服务上，结果不可信。`
    );
    process.exit(1);
  }
}

function spawnServer() {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });
  child.fxExited = null;
  child.stdout.on('data', (d) => process.env.FXDESK_VERBOSE && process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));
  child.on('exit', (code, signal) => {
    child.fxExited = { code, signal };
  });
  child.fxStop = () => new Promise((resolve) => {
    if (child.fxExited) return resolve();
    if (process.platform === 'win32') {
      // Windows 下终止整棵进程树（tsx 会派生子 node 进程，单杀父进程会残留占用端口）
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (child.fxExited || Date.now() - t0 > 15000) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  return child;
}

async function waitPortFree(timeoutMs = 15000) {
  const t0 = Date.now();
  while (await isPortInUse()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待端口 ${PORT} 释放超时`);
    await sleep(200);
  }
}

async function waitServer(timeoutMs = 40000) {
  const t0 = Date.now();
  for (;;) {
    if (server?.fxExited) {
      throw new Error(`服务器进程提前退出（code=${server.fxExited.code}）——端口 ${PORT} 可能被占用`);
    }
    try {
      const r = await fetch(BASE + '/api/queue');
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务器启动超时');
    await sleep(400);
  }
}

async function waitJobStatus(jobId, statuses, timeoutMs = 180000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', `/api/jobs/${jobId}`);
    last = r.json;
    if (r.status === 200 && statuses.includes(r.json.job.status)) return r.json;
    if (r.status !== 200) throw new Error(`查询客单失败：${JSON.stringify(r.json)}`);
    await sleep(800);
  }
  throw new Error(`等待状态 ${statuses.join('/')} 超时，最后状态=${last?.job?.status} err=${JSON.stringify(last?.runs?.at(-1)?.error ?? null)}`);
}

async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(600);
  }
  throw new Error(`等待「${label}」超时`);
}

async function check(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, pass: true, detail: detail ?? '' });
    console.log(`  [PASS] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ id, name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    console.error(`  [FAIL] ${id} ${name} — ${e instanceof Error ? e.message : e}`);
  }
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, msg) => expect(Object.is(a, b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/* ================= 主流程 ================= */
console.log('== FXDesk 端到端验收（模拟模式）==');

const sseEvents = [];
const sseAbort = new AbortController();
let sseDone = null;
await assertPortFree();
server = spawnServer();
try {
  await waitServer();
  console.log('服务器已启动：' + BASE);

  /* ---------- #1 基础设置 / 连接测试 / 余额 ---------- */
  await check('1.1', '设置读写 + 开启模拟模式（含关闭通知音）', async () => {
    const r = await api('PUT', '/api/settings', { mockApi: true, notifySound: false, notifyToast: false, baseUrl: 'https://api.momoapi.icu', apiKey: '' });
    eq(r.status, 200, 'PUT /api/settings 状态码');
    eq(r.json.mockApi, true, 'mockApi 已开启');
    return 'mockApi=true，通知已关闭';
  });

  await check('1.2', '测试连接（GET /v1/models）', async () => {
    const r = await api('POST', '/api/settings/test-connection', {});
    eq(r.status, 200, '状态码');
    eq(r.json.ok, true, '连接结果');
    expect(Array.isArray(r.json.models) && r.json.models.length > 0, '返回模型列表');
    return `模型 ${r.json.models.length} 个`;
  });

  await check('1.3', '顶栏余额（GET /api/usage/token/ 代理）', async () => {
    const r = await api('GET', '/api/balance');
    eq(r.status, 200, '状态码');
    expect(typeof r.json.balance === 'number', 'balance 字段');
    return `balance=${r.json.balance}`;
  });

  /* ---------- SSE 捕获 ---------- */
  sseDone = (async () => {
    try {
      const res = await fetch(BASE + '/api/events', { signal: sseAbort.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() ?? '';
        for (const c of chunks) {
          const ev = /event: (.+)/.exec(c)?.[1];
          const dataLine = /data: (.+)/.exec(c)?.[1];
          if (ev) {
            let data = null;
            try {
              data = dataLine ? JSON.parse(dataLine) : null;
            } catch {
              /* ignore */
            }
            sseEvents.push({ ev, data });
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  /* ---------- #2 新建客单 + 素材 ---------- */
  const demoPhoto = path.join(WS, 'demo', 'demo-photo.jpg');
  const demoSword = path.join(WS, 'demo', 'demo-sword.png');
  expect(fs.existsSync(demoPhoto), '演示场照存在（npm run seed）');

  let jobId = null;
  await check('2.1', '新建客单（multipart 原图 ≤50MB）', async () => {
    const fd = fileForm('original', demoPhoto);
    fd.append('name', '验收-雨夜剑闪');
    const r = await api('POST', '/api/jobs', undefined, fd);
    eq(r.status, 200, '创建状态');
    jobId = r.json.id;
    expect(/^\d{8}-\d{2}$/.test(jobId), `客单 ID 格式 日期-序号（${jobId}）`);
    return `id=${jobId} ${r.json.width}×${r.json.height}`;
  });

  await check('2.2', '添加客户素材（剑）', async () => {
    const r = await api('POST', `/api/jobs/${jobId}/materials`, undefined, fileForm('file', demoSword));
    eq(r.status, 200, '上传状态');
    eq(r.json.orderIndex, 1, '参考图编号');
    return '参考图1=剑（客户）';
  });

  let lightningItemId = null;
  await check('2.3', '从库添加素材（闪电，库素材以引用关联）', async () => {
    const lib = await api('GET', '/api/library/items?q=' + encodeURIComponent('闪电'));
    const item = [...lib.json.available, ...lib.json.history].find((i) => i.title === '闪电');
    expect(item, '素材库中存在「闪电」（npm run seed 预置）');
    lightningItemId = item.id;
    const r = await api('POST', `/api/jobs/${jobId}/materials`, { libraryItemId: item.id, displayName: '闪电' });
    eq(r.status, 200, '添加状态');
    eq(r.json.orderIndex, 2, '参考图编号');
    return `参考图2=闪电（库 ${item.id.slice(0, 8)}）`;
  });

  /* ---------- #3 标注 / 指令 / 全局 ---------- */
  await check('3.1', '画 2 个框 + 填指令 + 全局指令（服务端拼装预览）', async () => {
    const r = await api('PUT', `/api/jobs/${jobId}/regions`, {
      regions: [
        { color: '#E53935', bbox: { x1: 420, y1: 850, x2: 780, y2: 1150 }, instruction: '在手中添加参考图1的剑，握持关系自然，剑身受光与环境光一致', refTokens: [{ materialId: 'x', refNo: 1, name: '剑' }] },
        { color: '#FDD835', bbox: { x1: 330, y1: 500, x2: 900, y2: 1350 }, instruction: '身体周围添加参考图2的闪电特效，光效与轮廓光方向一致', refTokens: [{ materialId: 'y', refNo: 2, name: '闪电' }] },
      ],
    });
    eq(r.status, 200, '保存区域');
    const p = await api('PATCH', `/api/jobs/${jobId}`, { global_instruction: '将背景整体替换为雨夜街道，霓虹反光与人物轮廓光方向一致' });
    eq(p.status, 200, '保存全局');
    const d = await api('GET', `/api/jobs/${jobId}`);
    const preview = d.json.preview;
    eq(d.json.regions.length, 2, '区域数');
    eq(d.json.regions[0].color, '#E53935', '① 红');
    eq(d.json.regions[1].color, '#FDD835', '② 黄');
    expect(preview.finalPrompt.includes('【红框 第1区】'), '区域1 拼装');
    expect(preview.finalPrompt.includes('【黄框 第2区】'), '区域2 拼装');
    expect(preview.finalPrompt.includes('参考图1的剑'), '参考图1 引用');
    expect(preview.finalPrompt.includes('参考图2的闪电'), '参考图2 引用');
    expect(preview.finalPrompt.includes('【全局修改】'), '全局块');
    expect(preview.finalPrompt.includes('移除画面上所有彩色框标记'), '收尾块（标记移除）');
    expect(/画面.+部|画面中央/.test(preview.finalPrompt), '自动方位描述');
    return `拼装 ${preview.finalPrompt.length} 字，区域线条目完整`;
  });

  await check('3.2', '空指令拦截（第3个空框 → 生成被拒）', async () => {
    const cur = await api('GET', `/api/jobs/${jobId}`);
    const regions = cur.json.regions.map((x) => ({ id: x.id, color: x.color, bbox: x.bbox, instruction: x.instruction, refTokens: x.refTokens }));
    regions.push({ id: 'tmp-empty', color: '#1E88E5', bbox: { x1: 50, y1: 50, x2: 150, y2: 150 }, instruction: '', refTokens: [] });
    await api('PUT', `/api/jobs/${jobId}/regions`, { regions });
    const g = await api('POST', `/api/jobs/${jobId}/generate`, {});
    eq(g.status, 400, '应被拒绝');
    eq(g.json.error.code, 'EMPTY_INSTRUCTION', '错误码');
    // 移除空框
    const fixed = regions.filter((x) => x.id !== 'tmp-empty');
    await api('PUT', `/api/jobs/${jobId}/regions`, { regions: fixed });
    return '空指令被正确拦截（EMPTY_INSTRUCTION）';
  });

  /* ---------- #4 生成（队列 / SSE / 费用） ---------- */
  let firstRunId = null;
  await check('4.1', '点击生成 → 入队 → 生成中 → 质检 → 待审核', async () => {
    const g = await api('POST', `/api/jobs/${jobId}/generate`, {});
    eq(g.status, 200, '入队状态');
    firstRunId = g.json.runId;
    const q = await api('GET', '/api/queue');
    expect(q.json.pending.length + q.json.active.length >= 1 || (await api('GET', `/api/jobs/${jobId}`)).json.job.status === 'review', '队列中出现任务');
    const d = await waitJobStatus(jobId, ['review'], 180000);
    const run = d.runs.at(-1);
    eq(run.status, 'done', 'Run 完成');
    eq(run.cost, 0.3, '费用 0.30');
    expect(run.elapsedMs > 0, '耗时记录');
    return `Run${run.seq} done，费用 ¥${run.cost}，耗时 ${run.elapsedMs}ms`;
  });

  await check('4.2', 'SSE 推送（snapshot / job_update / run_progress）', async () => {
    expect(sseEvents.some((e) => e.ev === 'snapshot'), '收到 snapshot 快照（断线重连补全量）');
    const jobEvents = sseEvents.filter((e) => e.ev === 'job_update' && e.data?.jobId === jobId);
    expect(jobEvents.length >= 2, `收到 ${jobEvents.length} 条 job_update`);
    const stages = new Set(jobEvents.map((e) => e.data.stage).filter(Boolean));
    expect(stages.has('queued') || stages.has('uploading'), '包含排队/上传阶段');
    expect(stages.has('review'), '包含进入审核事件');
    expect(sseEvents.some((e) => e.ev === 'run_progress'), '收到 run_progress 进度');
    return `job_update×${jobEvents.length}，阶段 ${[...stages].join(',')}`;
  });

  /* ---------- #5 结果检查 ---------- */
  await check('5.1', '结果文件 + QC（身份/构图）+ 无标记残留', async () => {
    const d = await api('GET', `/api/jobs/${jobId}`);
    const run = d.json.runs.find((r) => r.id === firstRunId);
    expect(run.resultUrl, '结果图 URL');
    const img = await fetch(BASE + run.resultUrl);
    eq(img.status, 200, '结果图可访问');
    const bytes = Buffer.from(await img.arrayBuffer());
    expect(bytes.length > 1000, '结果图非空');
    expect(run.markerUrl, '标记图留档（01_markers）');
    const markerRes = await fetch(BASE + run.markerUrl);
    eq(markerRes.status, 200, '标记图可访问');
    // 构图质检证明「无标记残留」：SSIM 极高且 pHash 距离为 0（若有框残留会显著下降）
    expect(run.qc?.composition, '构图 QC 已执行');
    expect(run.qc.composition.verdict === 'ok', `构图一致（${JSON.stringify(run.qc.composition)}）`);
    expect(run.qc.composition.phashDistance === 0, 'pHash 距离 0（无标记残留）');
    // 身份 QC 管线已启用（演示图无真实人脸 → 正确分流为 no_face 转人工）
    expect(run.qc.identity.status === 'skipped' && run.qc.identity.reason === 'no_face', `身份 QC 分流（${JSON.stringify(run.qc.identity)}）`);
    return `QC：构图 ok（SSIM ${run.qc.composition.ssim}，pHash 0）；身份 skipped(no_face)`;
  });

  /* ---------- #6 交付 ---------- */
  await check('6.1', '通过交付 → delivered + 03_delivery/final_v1.png', async () => {
    const r = await api('POST', `/api/jobs/${jobId}/deliver`, { runId: firstRunId });
    eq(r.status, 200, '交付状态');
    const finalAbs = path.join(WS, 'jobs', jobId, '03_delivery', 'final_v1.png');
    expect(fs.existsSync(finalAbs), '03_delivery/final_v1.png 存在');
    const d = await api('GET', `/api/jobs/${jobId}`);
    eq(d.json.job.status, 'delivered', '客单状态');
    return r.json.tags.join('、');
  });

  /* ---------- #7 归档与搜索 ---------- */
  await check('7.1', '历史成果归档（自动标签含 剑/闪电/颜色）+ 搜索 + ⭐', async () => {
    const search = await api('GET', '/api/library/items?q=' + encodeURIComponent('闪电'));
    const hist = search.json.history.find((i) => i.jobId === jobId);
    expect(hist, '搜索「闪电」命中历史成果');
    expect(hist.tags.includes('剑'), '标签含 剑');
    expect(hist.tags.includes('闪电'), '标签含 闪电');
    expect(hist.tags.some((t) => t.endsWith('色')), '标签含主色');
    const f = await api('POST', `/api/library/items/${hist.id}/favorite`, { favorite: true });
    eq(f.status, 200, '收藏');
    return `标签：${hist.tags.join('、')}`;
  });

  /* ---------- #8 净版提取 ---------- */
  await check('8.1', '提取净版 → candidate（黑底无人物）→ ⭐ 升为正式', async () => {
    const ep = await api('POST', '/api/library/extract-plate', { jobId, effectDescription: '闪电' });
    eq(ep.status, 200, '触发提取');
    const itemId = ep.json.itemId;
    // 轮询完成
    let row = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const list = await api('GET', '/api/library/items?q=' + encodeURIComponent('闪电'));
      row = [...list.json.available, ...list.json.history].find((x) => x.id === itemId);
      if (row && row.width) break;
    }
    expect(row, '净版已入库');
    expect(row.width > 0, '净版已生成（有尺寸）');
    expect(row.status === 'candidate', `candidate 状态（${row.status}）`);
    expect(row.background === 'black', `黑底（${row.background}）`);
    expect(row.tags.includes('净版'), '含净版标签');
    const f = await api('POST', `/api/library/items/${itemId}/favorite`, { favorite: true });
    eq(f.status, 200, '收藏');
    const after = await api('GET', '/api/library/items?zone=favorites');
    const promoted = after.json.items.find((x) => x.id === itemId);
    expect(promoted && promoted.status === 'active', '⭐ 后升为正式素材（active）');
    return `item ${itemId.slice(0, 8)} → active + 收藏夹`;
  });

  /* ---------- #9 复用配方 ---------- */
  await check('9.1', '复用配方 → 新 draft 带原区域与指令结构 → 换图', async () => {
    const c = await api('POST', `/api/jobs/${jobId}/clone`, {});
    eq(c.status, 200, '克隆状态');
    const newId = c.json.id;
    const d = await api('GET', `/api/jobs/${newId}`);
    eq(d.json.job.status, 'draft', '新客单为 draft');
    eq(d.json.regions.length, 2, '区域结构复制');
    expect(d.json.regions[0].instruction.includes('参考图1的剑'), '指令复制');
    eq(d.json.materials.length, 2, '素材引用复制（库引用不复制文件）');
    expect(d.json.materials[1].libraryItemId === lightningItemId, '库素材仍为引用关联');
    // 换图
    const rep = await api('POST', `/api/jobs/${newId}/original`, undefined, fileForm('original', demoPhoto));
    eq(rep.status, 200, '替换原图');
    return `新客单 ${newId}（draft，2 区域 2 素材），已换图`;
  });

  /* ---------- #10 定点重修回路 ---------- */
  await check('10.1', '定点重修 → 新 Run + QC 重新执行', async () => {
    const d0 = await api('GET', `/api/jobs/${jobId}`);
    const before = d0.json.runs.length;
    const r = await api('POST', `/api/jobs/${jobId}/repair`, {
      baseRunId: firstRunId,
      regions: [{ color: '#1E88E5', bbox: { x1: 450, y1: 900, x2: 700, y2: 1100 }, instruction: '该区域剑柄与手部穿插错误，参考原图手型修正，保持光影一致' }],
    });
    eq(r.status, 200, '重修入队');
    const d = await waitJobStatus(jobId, ['review'], 180000);
    eq(d.runs.length, before + 1, '新增 Run');
    const repairRun = d.runs.at(-1);
    eq(repairRun.type, 'repair', 'Run 类型 repair');
    expect(repairRun.qc?.composition, '重修后 QC 已重新执行');
    return `Run${repairRun.seq} repair done，QC=${JSON.stringify(repairRun.qc.composition)}`;
  });

  /* ---------- #11 中断恢复 ---------- */
  await check('11.1', '生成中重启 → interrupted 可重试 → 重试成功', async () => {
    // 克隆一个客单，模拟“生成中”
    const c = await api('POST', `/api/jobs/${jobId}/clone`, {});
    const jid = c.json.id;
    // 停服（Windows 下需终止整棵进程树，并等待端口真正释放）
    await server.fxStop();
    await waitPortFree();
    // 直接改库模拟中断态
    const db = new Database(path.join(WS, 'db.sqlite'));
    const runId = 'interrupted-' + Date.now();
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM runs WHERE job_id=?').get(jid)).m + 1;
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jid);
    db.prepare("INSERT INTO runs (id, job_id, seq, type, status, base_run_id, created_at) VALUES (?,?,?,'initial','queued',NULL,?)").run(runId, jid, seq, Date.now());
    db.close();
    // 重启
    server = spawnServer();
    await waitServer();
    const d = await api('GET', `/api/jobs/${jid}`);
    eq(d.json.job.status, 'failed', '重启后中断客单标为 failed');
    const run = d.json.runs.find((x) => x.id === runId);
    eq(run.error, 'interrupted', '跑中 Run 标为 interrupted');
    // 重试
    const retry = await api('POST', `/api/runs/${runId}/retry`, {});
    eq(retry.status, 200, '重试可入队');
    const done = await waitJobStatus(jid, ['review'], 180000);
    const newRun = done.runs.find((x) => x.id === retry.json.runId);
    eq(newRun.status, 'done', '重试后成功');
    return `中断恢复 → 重试 Run${newRun.seq} done`;
  });

  /* ---------- #12 失败路径 ---------- */
  await check('12.1', 'Key 无效 → 失败红标（错误信息）→ 修复后重试成功', async () => {
    // 本地假 API：一律返回 401
    const fake = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise((r) => fake.listen(3211, '127.0.0.1', r));
    try {
      await api('PUT', '/api/settings', { mockApi: false, apiKey: 'sk-invalid-test', baseUrl: 'http://127.0.0.1:3211' });
      const c = await api('POST', `/api/jobs/${jobId}/clone`, {});
      const jid = c.json.id;
      const g = await api('POST', `/api/jobs/${jid}/generate`, {});
      eq(g.status, 200, '入队');
      const d = await waitJobStatus(jid, ['failed'], 60000);
      const run = d.runs.at(-1);
      expect(run.error.includes('API Key 无效或过期'), `错误信息正确（${run.error}）`);
      // 修复 Key（切回模拟）→ 重试
      await api('PUT', '/api/settings', { mockApi: true });
      const retry = await api('POST', `/api/runs/${run.id}/retry`, {});
      eq(retry.status, 200, '重试入队');
      const done = await waitJobStatus(jid, ['review'], 180000);
      eq(done.runs.at(-1).status, 'done', '重试成功');
      return `失败信息「${run.error}」→ 修复后 Run${done.runs.at(-1).seq} done`;
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });

  /* ---------- #13 软删除 / trash ---------- */
  await check('13.1', '删除客单 → 索引移除 + 文件入 trash', async () => {
    const c = await api('POST', `/api/jobs/${jobId}/clone`, {});
    const jid = c.json.id;
    const del = await api('DELETE', `/api/jobs/${jid}`);
    eq(del.status, 200, '删除');
    const g = await api('GET', `/api/jobs/${jid}`);
    eq(g.status, 404, '索引已移除');
    const trashEntries = fs.readdirSync(path.join(WS, 'trash')).filter((f) => f.startsWith(jid));
    expect(trashEntries.length === 1, `文件已移入 trash（${trashEntries.join(',')}）`);
    return `trash/${trashEntries[0]}`;
  });

  /* ---------- #14 AI 筹备（识别 → 见解 → 特效预演 → 入库 → 合成注入） ---------- */
  let prepJobId = null;
  let fxId = null;

  await check('14.1', '角色识别（分析模型 mock）→ 人工确认同步客单角色名', async () => {
    const c = await api('POST', `/api/jobs/${jobId}/clone`, {});
    prepJobId = c.json.id;
    const a = await api('POST', `/api/jobs/${prepJobId}/prep/analyze`, {});
    eq(a.status, 200, '发起识别');
    const done = await waitUntil(async () => {
      const p = await api('GET', `/api/jobs/${prepJobId}/prep`);
      if (p.json.prep.analysis.status === 'failed') throw new Error(`识别失败：${p.json.prep.analysis.error}`);
      return p.json.prep.analysis.status === 'done' ? p.json : null;
    }, 30000, '识别完成');
    expect(done.prep.analysis.result?.character, '识别出角色名');
    const save = await api('PUT', `/api/jobs/${prepJobId}/prep/analysis`, { character: '验收角色', work: '验收作品' });
    eq(save.status, 200, '保存确认');
    const d = await api('GET', `/api/jobs/${prepJobId}`);
    eq(d.json.job.character, '验收角色', '角色名已同步客单（用于搜索关键词与归档标签）');
    return `识别「${done.prep.analysis.result.character}」→ 确认为「验收角色」`;
  });

  await check('14.2', '特效见解（mock）→ 自动落成特效条目', async () => {
    const p = await api('POST', `/api/jobs/${prepJobId}/prep/propose`, {});
    eq(p.status, 200, '发起见解');
    const done = await waitUntil(async () => {
      const r = await api('GET', `/api/jobs/${prepJobId}/prep`);
      if (r.json.prep.proposal.status === 'failed') throw new Error(`见解失败：${r.json.prep.proposal.error}`);
      return r.json.prep.proposal.status === 'done' && r.json.effects.length ? r.json : null;
    }, 30000, '见解完成');
    return `生成 ${done.effects.length} 条特效建议（首条「${done.effects[0].title}」）`;
  });

  await check('14.3', '特效预演（type=effect Run）→ 1K 草图待确认', async () => {
    const prep = await api('GET', `/api/jobs/${prepJobId}/prep`);
    const fx = prep.json.effects?.[0];
    expect(fx, '存在特效条目（前置见解步骤应已成功）');
    fxId = fx.id;
    const upd = await api('PUT', `/api/jobs/${prepJobId}/prep/effects/${fxId}`, {
      genPrompt: '在人物身体周围添加环绕的蓝紫色闪电弧光，受光与场图环境光方向一致',
      blendPrompt: '本特效环绕人物身后与两侧，人物位于前景遮挡中段光弧',
    });
    eq(upd.status, 200, '编辑生成/融入描述');
    const g = await api('POST', `/api/jobs/${prepJobId}/prep/effects/${fxId}/generate`, {});
    eq(g.status, 200, '发起生成');
    const cur = await waitUntil(async () => {
      const r = await api('GET', `/api/jobs/${prepJobId}/prep`);
      const e = r.json.effects.find((x) => x.id === fxId);
      if (e.status === 'failed') throw new Error(`特效预演失败：${e.error}`);
      return e.status === 'review' ? e : null;
    }, 60000, '特效预演完成');
    expect(cur.imageUrl, '预演图已产出');
    const job = await api('GET', `/api/jobs/${prepJobId}`);
    eq(job.json.job.status, 'draft', '特效预演不改变客单状态');
    return `预演图 ${cur.imageUrl}`;
  });

  await check('14.4', '审批入库 → 特效素材（含融入说明）+ 加为参考图 + 预览注入', async () => {
    const r = await api('POST', `/api/jobs/${prepJobId}/prep/effects/${fxId}/approve`, {});
    eq(r.status, 200, '入库');
    expect(r.json.refNo >= 1, '已加为参考图');
    const d = await api('GET', `/api/jobs/${prepJobId}`);
    const m = d.json.materials.find((x) => x.libraryItemId === r.json.itemId);
    expect(m, '客单素材已包含特效');
    eq(m.role, 'effect', '素材用途=特效');
    expect(m.blendPrompt.includes('环绕人物身后'), '融入说明已随素材带入');
    const put = await api('PUT', `/api/jobs/${prepJobId}/regions`, {
      regions: [
        {
          color: '#E53935',
          bbox: { x1: 100, y1: 100, x2: 600, y2: 600 },
          instruction: `把参考图${m.orderIndex}的特效溶入画面，注意人物遮挡关系`,
          refTokens: [{ materialId: m.id, refNo: m.orderIndex, name: m.displayName }],
        },
      ],
    });
    eq(put.status, 200, '区域引用已保存');
    const pv = await api('GET', `/api/jobs/${prepJobId}/prompt-preview`);
    expect(pv.json.finalPrompt.includes('融入要求'), '预览提示词含融入要求');
    expect(pv.json.finalPrompt.includes('环绕人物身后'), '预览提示词含融入原文');
    const lib = await api('GET', '/api/library/items?zone=library');
    const item = (lib.json.items ?? []).find((i) => i.id === r.json.itemId);
    eq(item?.type, 'effect', '库素材类型=effect');
    expect(item.blendPrompt.includes('环绕人物身后'), '库素材保留融入说明');
    return `库素材 type=effect + 参考图${r.json.refNo} + 预览注入`;
  });

  await check('14.5', '最终合成 Run 提示词自动携带融入说明', async () => {
    const g = await api('POST', `/api/jobs/${prepJobId}/generate`, {});
    eq(g.status, 200, '入队合成');
    const done = await waitJobStatus(prepJobId, ['review'], 180000);
    const run = done.runs.find((x) => x.finalPrompt && x.finalPrompt.includes('融入要求'));
    expect(run, '生成 Run 全文包含融入要求');
    return `Run${run.seq} finalPrompt 已注入`;
  });

  /* ---------- 收尾：恢复设置 ---------- */
  await check('Z', '恢复设置（关闭模拟 / 清空 Key / 还原 Base URL / 通知恢复默认开）', async () => {
    const r = await api('PUT', '/api/settings', { mockApi: false, apiKey: '', baseUrl: 'https://api.momoapi.icu', notifySound: true, notifyToast: true });
    eq(r.status, 200, '恢复');
    return '已还原为出厂配置';
  });
} finally {
  sseAbort.abort();
  void sseDone;
  if (server) await server.fxStop();
}

/* ================= 汇总 ================= */
const passed = results.filter((r) => r.pass).length;
const total = results.length;
const summary = {
  ranAt: new Date().toISOString(),
  mode: 'mock（离线模拟管线；真实 API 验收条目见 ACCEPTANCE.md）',
  passed,
  total,
  results,
};
fs.writeFileSync(path.join(root, 'acceptance-results.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`\n== 结果：${passed}/${total} 通过 ==`);
console.log('明细已写入 acceptance-results.json');
process.exit(passed === total ? 0 : 1);
