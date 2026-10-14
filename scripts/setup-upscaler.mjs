/**
 * 安装 Real-ESRGAN 超分引擎至 <项目根>/tools/realesrgan（PRD §4.6.8）。
 * 下载源顺序：
 *   1. GitHub Releases（可用 UPSCALER_MIRROR 指定镜像前缀，如 https://gh-proxy.com）
 *   2. npmmirror（upscayl-node 包内含 upscayl-bin.exe + realesrgan-x4plus 模型，CLI 与 realesrgan-ncnn-vulkan 兼容）
 * 失败不阻断：交付链路会按规则自动降级 Lanczos。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

/** Windows + Node 24：含非 ASCII 路径时 fs.rmSync 静默失效，统一用 unlink/rmdir 组合 */
function removePathQuiet(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(target)) removePathQuiet(path.join(target, n));
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  } catch {
    /* ignore */
  }
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const toolsDir = process.env.FXDESK_UPSCALER_DIR
  ? path.resolve(process.env.FXDESK_UPSCALER_DIR)
  : path.join(projectRoot, 'tools', 'realesrgan');

const ZIP_NAME = 'realesrgan-ncnn-vulkan-20220424-windows.zip';
const ZIP_URL = `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/${ZIP_NAME}`;
const MIRROR = process.env.UPSCALER_MIRROR ? process.env.UPSCALER_MIRROR.replace(/\/+$/, '') : '';
const NPM_META = 'https://registry.npmmirror.com/upscayl-node/latest';
const EXE_NAMES = process.platform === 'win32' ? ['realesrgan-ncnn-vulkan.exe', 'upscayl-bin.exe'] : ['realesrgan-ncnn-vulkan', 'upscayl-bin'];

function findExe() {
  return EXE_NAMES.map((n) => path.join(toolsDir, n)).find((p) => fs.existsSync(p)) ?? null;
}

function ready() {
  const exe = findExe();
  return !!exe && fs.existsSync(path.join(toolsDir, 'models', 'realesrgan-x4plus.param')) && fs.existsSync(path.join(toolsDir, 'models', 'realesrgan-x4plus.bin'));
}

if (process.platform !== 'win32') {
  console.log('[upscaler] 当前提供 Windows 版引擎；其他平台将自动降级 Lanczos。');
  process.exit(0);
}

if (ready()) {
  console.log(`[upscaler] 引擎已就绪：${toolsDir}`);
  process.exit(0);
}

async function download(src, dest) {
  const tmp = dest + '.part';
  const resp = await fetch(src, { redirect: 'follow' });
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

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function copyInto(fromDir) {
  fs.mkdirSync(path.join(toolsDir, 'models'), { recursive: true });
  for (const entry of fs.readdirSync(fromDir)) {
    const p = path.join(fromDir, entry);
    if (/\.(exe|dll)$/i.test(entry)) fs.cpSync(p, path.join(toolsDir, entry), { force: true });
  }
  const modelsSrc = path.join(fromDir, 'models');
  if (fs.existsSync(modelsSrc)) {
    for (const entry of fs.readdirSync(modelsSrc)) {
      fs.cpSync(path.join(modelsSrc, entry), path.join(toolsDir, 'models', entry), { force: true });
    }
  }
}

async function fromGithub() {
  const zipPath = path.join(path.dirname(toolsDir), ZIP_NAME);
  const tmpDir = path.join(path.dirname(toolsDir), '_upscaler_unzip_tmp');
  try {
    const candidates = MIRROR ? [`${MIRROR}/${ZIP_URL}`, ZIP_URL] : [ZIP_URL];
    let downloaded = false;
    for (const src of candidates) {
      try {
        console.log(`[upscaler] 尝试 GitHub ← ${src}`);
        await download(src, zipPath);
        downloaded = true;
        break;
      } catch (e) {
        console.warn(`[upscaler] GitHub 源失败：${e.message}`);
      }
    }
    if (!downloaded) throw new Error('GitHub 源均不可达');
    removePathQuiet(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmpDir}" -Force`],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error('Expand-Archive 失败');
    const exePath = findFile(tmpDir, 'realesrgan-ncnn-vulkan.exe');
    if (!exePath) throw new Error('zip 中未找到引擎');
    fs.mkdirSync(toolsDir, { recursive: true });
    copyInto(path.dirname(exePath));
    const modelsSrc = findFile(tmpDir, 'realesrgan-x4plus.param');
    if (modelsSrc && !fs.existsSync(path.join(toolsDir, 'models', 'realesrgan-x4plus.param'))) {
      fs.mkdirSync(path.join(toolsDir, 'models'), { recursive: true });
      fs.cpSync(modelsSrc, path.join(toolsDir, 'models', 'realesrgan-x4plus.param'), { force: true });
      fs.cpSync(modelsSrc.replace(/\.param$/, '.bin'), path.join(toolsDir, 'models', 'realesrgan-x4plus.bin'), { force: true });
    }
  } finally {
    removePathQuiet(tmpDir);
    removePathQuiet(zipPath);
  }
}

async function fromNpmMirror() {
  const tgzPath = path.join(path.dirname(toolsDir), 'upscayl-node.tgz');
  const tmpDir = path.join(path.dirname(toolsDir), '_upscaler_tgz_tmp');
  try {
    const metaResp = await fetch(NPM_META);
    if (!metaResp.ok) throw new Error(`registry 元数据 HTTP ${metaResp.status}`);
    const meta = await metaResp.json();
    const tarball = meta.dist?.tarball;
    if (!tarball) throw new Error('registry 未返回 tarball 地址');
    console.log(`[upscaler] 尝试 npmmirror ← ${tarball}`);
    await download(tarball, tgzPath);
    removePathQuiet(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    const r = spawnSync('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar 解压失败（需要 Windows 10+ 自带 tar）');
    const exePath = findFile(tmpDir, 'upscayl-bin.exe');
    if (!exePath) throw new Error('tgz 中未找到 upscayl-bin.exe');
    fs.mkdirSync(toolsDir, { recursive: true });
    copyInto(path.dirname(exePath));
    const modelsSrc = findFile(tmpDir, 'realesrgan-x4plus.param');
    if (!modelsSrc) throw new Error('tgz 中未找到 realesrgan-x4plus 模型');
    fs.mkdirSync(path.join(toolsDir, 'models'), { recursive: true });
    fs.cpSync(modelsSrc, path.join(toolsDir, 'models', 'realesrgan-x4plus.param'), { force: true });
    fs.cpSync(modelsSrc.replace(/\.param$/, '.bin'), path.join(toolsDir, 'models', 'realesrgan-x4plus.bin'), { force: true });
  } finally {
    removePathQuiet(tmpDir);
    removePathQuiet(tgzPath);
  }
}

try {
  await fromGithub();
} catch (e) {
  console.warn(`[upscaler] GitHub 安装失败：${e.message}`);
  try {
    await fromNpmMirror();
  } catch (e2) {
    console.warn(`[upscaler] npmmirror 安装失败：${e2.message}`);
  }
}

if (ready()) console.log(`[upscaler] 引擎就绪：${toolsDir}`);
else console.warn('[upscaler] 安装未完成（不阻断，交付将自动降级 Lanczos）。可设置镜像后重试：UPSCALER_MIRROR=https://gh-proxy.com npm run setup-upscaler');
