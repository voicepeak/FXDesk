/**
 * 下载 InsightFace buffalo_l QC 模型到 <workspace>/models（§C.1）。
 * 源顺序：
 *   1. 直接在配置镜像中下载单个 onnx（MODEL_MIRROR 可覆盖，默认 hf-mirror.com → huggingface.co）
 *   2. 回退：GitHub Releases 官方 buffalo_l.zip 下载并解压（含 det_10g.onnx / w600k_r50.onnx）
 * 下载失败不阻断（QC 自动降级为人工目检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function workspaceRoot() {
  if (process.env.FXDESK_WORKSPACE) return path.resolve(process.env.FXDESK_WORKSPACE);
  try {
    const p = JSON.parse(fs.readFileSync(path.join(projectRoot, 'fxdesk.config.json'), 'utf8'));
    if (p.workspacePath) {
      return path.isAbsolute(p.workspacePath) ? p.workspacePath : path.resolve(projectRoot, p.workspacePath);
    }
  } catch {
    /* default */
  }
  return path.join(projectRoot, 'workspace');
}

const FILES = ['det_10g.onnx', 'w600k_r50.onnx'];
const SUBPATH = 'deepinsight/insightface/resolve/main/model_zoo/buffalo_l/';
const MIRRORS = process.env.MODEL_MIRROR
  ? [process.env.MODEL_MIRROR.replace(/\/+$/, '')]
  : ['https://hf-mirror.com', 'https://huggingface.co'];
const ZIP_URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';

const outDir = path.join(workspaceRoot(), 'models');
fs.mkdirSync(outDir, { recursive: true });

async function download(url, dest) {
  const tmp = dest + '.part';
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get('content-length') ?? 0);
  const file = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    file.write(Buffer.from(value));
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${path.basename(dest)} ${pct}%\r`);
      }
    }
  }
  await new Promise((resolve, reject) => file.end(() => resolve()).on('error', reject));
  fs.renameSync(tmp, dest);
}

async function tryDirect() {
  for (const f of FILES) {
    const dest = path.join(outDir, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
      console.log(`[models] ${f} 已存在，跳过`);
      continue;
    }
    let done = false;
    for (const mirror of MIRRORS) {
      const u = `${mirror}/${SUBPATH}${f}`;
      try {
        console.log(`[models] 下载 ${f} ← ${u}`);
        await download(u, dest);
        console.log(`[models] ${f} 完成（${(fs.statSync(dest).size / 1048576).toFixed(1)} MB）`);
        done = true;
        break;
      } catch (e) {
        console.warn(`[models] 失败：${e.message}`);
      }
    }
    if (!done) return false;
  }
  return true;
}

function unzip(zipPath, destDir, names) {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error('Expand-Archive 失败');
  } else {
    const r = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('unzip 失败');
  }
  const found = [];
  for (const n of names) {
    // zip 内可能带子目录
    const candidates = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === n) candidates.push(p);
      }
    };
    walk(destDir);
    if (!candidates.length) throw new Error(`zip 中未找到 ${n}`);
    fs.copyFileSync(candidates[0], path.join(outDir, n));
    found.push(n);
  }
  return found;
}

async function tryZip() {
  const zipPath = path.join(outDir, 'buffalo_l.zip');
  const tmpDir = path.join(outDir, '_unzip_tmp');
  try {
    console.log(`[models] 回退：下载官方 zip ← ${ZIP_URL}`);
    await download(ZIP_URL, zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const got = unzip(zipPath, tmpDir, FILES);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    console.log(`[models] zip 解压完成：${got.join(', ')}`);
    return true;
  } catch (e) {
    console.warn(`[models] zip 回退失败：${e.message}`);
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return false;
  }
}

let ok = await tryDirect();
if (!ok) ok = await tryZip();

const have = FILES.filter((f) => fs.existsSync(path.join(outDir, f)));
if (have.length === FILES.length) console.log('[models] QC 模型就绪');
else console.log(`[models] 部分模型缺失（${FILES.filter((f) => !have.includes(f)).join(', ')}），QC 将降级为人工目检。可稍后重跑 npm run setup-models`);
