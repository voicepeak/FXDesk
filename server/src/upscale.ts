import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { PROJECT_ROOT } from './env';
import { MomoError } from './momo';
import { logLine } from './logger';
import { removePathQuiet } from './fsSafe';
import type { UpscaleRecord } from './types';

export type UpscaleEngine = 'realesrgan' | 'lanczos';

const ESRGAN_MODEL_MAIN = 'realesrgan-x4plus';
const ESRGAN_MODEL_FAST = 'realesrgan-x4fast';
const ESRGAN_TILE = Number(process.env.FXDESK_UPSCALER_TILE) > 0 ? Number(process.env.FXDESK_UPSCALER_TILE) : 1024;
const ESRGAN_FALLBACK_TILE = 512;
const ESRGAN_MAX_SCALE = 4;
const LANCZOS_ONLY_RATIO = 1.05; // §4.6.8：差距 ≤5% 时直接 Lanczos，无感
const ASPECT_CROP_THRESHOLD = 0.02; // §4.6.8：宽高比偏差 >2% 时 cover 裁剪

export function upscalerDir(): string {
  return process.env.FXDESK_UPSCALER_DIR || path.join(PROJECT_ROOT, 'tools', 'realesrgan');
}

function exeCandidates(dir: string): string[] {
  // upscayl-bin（维护中的 realesrgan 分支）优先：老版官方二进制在部分新驱动/多设备环境下会输出错位图
  return process.platform === 'win32'
    ? [path.join(dir, 'upscayl-bin.exe'), path.join(dir, 'realesrgan-ncnn-vulkan.exe')]
    : [path.join(dir, 'upscayl-bin'), path.join(dir, 'realesrgan-ncnn-vulkan')];
}

function modelReady(dir: string, model: string): boolean {
  return fs.existsSync(path.join(dir, 'models', `${model}.param`)) && fs.existsSync(path.join(dir, 'models', `${model}.bin`));
}

export function upscalerStatus(): { ok: boolean; exe: string; fast: boolean; reason?: string } {
  const dir = upscalerDir();
  const exe = exeCandidates(dir).find((p) => fs.existsSync(p)) ?? exeCandidates(dir)[0];
  if (!fs.existsSync(exe)) return { ok: false, exe, fast: false, reason: '引擎未安装（可在项目根运行 npm run setup-upscaler 安装）' };
  if (!modelReady(dir, ESRGAN_MODEL_MAIN)) return { ok: false, exe, fast: false, reason: '模型文件缺失（models/realesrgan-x4plus.*）' };
  return { ok: true, exe, fast: modelReady(dir, ESRGAN_MODEL_FAST) };
}

function runRealesrgan(
  exe: string,
  src: string,
  out: string,
  scale: number,
  tile: number,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new MomoError('CANCELED', '已取消'));
      return;
    }
    const args = [
      '-i', src,
      '-o', out,
      '-n', model,
      '-s', String(scale),
      '-t', String(tile),
      '-f', 'png',
      '-m', path.join(path.dirname(exe), 'models'),
    ];
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && !child.killed) child.kill();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`超分子进程超过 ${Math.round(timeoutMs / 1000)} 秒未完成`)), timeoutMs);
    const onAbort = () => finish((signal?.reason as Error) ?? new MomoError('CANCELED', '已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) finish();
      else finish(new Error(`超分进程退出码 ${code ?? 'null'}${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`));
    });
  });
}

export interface UpscaleOptions {
  /** 模型直出原图（未回填） */
  srcPath: string;
  /** 最终交付图输出路径（result_final.png） */
  outPath: string;
  /** 原图路径（用于 ICC 色彩配置读取） */
  origPath?: string;
  origW: number;
  origH: number;
  engine: UpscaleEngine;
  timeoutSec: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** §4.6.8 超分回填：把模型输出回填到与原图逐像素相等的尺寸（强制，engine 缺失/失败自动降级 Lanczos） */
export async function upscaleToOriginal(opts: UpscaleOptions): Promise<UpscaleRecord> {
  const startedAt = Date.now();
  const W = opts.origW;
  const H = opts.origH;
  if (!W || !H) throw new MomoError('UPSCALE_FAILED', '缺少原图尺寸，无法超分回填');

  const srcMeta = await sharp(opts.srcPath).metadata();
  const w = srcMeta.width ?? 0;
  const h = srcMeta.height ?? 0;
  if (!w || !h) throw new MomoError('UPSCALE_FAILED', '无法读取生成结果尺寸');

  const from = `${w}x${h}`;
  const to = `${W}x${H}`;
  const scaleFactor = Math.max(W / w, H / h);

  let workPath = opts.srcPath;
  let engineUsed: UpscaleEngine = 'lanczos';
  let engineModel: string | undefined;
  let degraded = false;
  let degradeReason: string | undefined;
  let iccPath: string | undefined;
  const outDir = path.dirname(opts.outPath);
  const tmpEsrgan = path.join(outDir, `.upscale_tmp_${Date.now()}.png`);
  sweepStaleTemp(outDir);

  try {
    if (scaleFactor <= LANCZOS_ONLY_RATIO) {
      opts.onProgress?.(`尺寸接近原图（${from}），直接缩放至 ${to}`);
    } else if (opts.engine !== 'realesrgan') {
      opts.onProgress?.(`Lanczos 缩放中 ${from} → ${to}`);
    } else {
      const status = upscalerStatus();
      if (!status.ok) {
        degraded = true;
        degradeReason = status.reason;
        logLine('warn', `超分引擎不可用，降级 Lanczos：${status.reason}`);
        opts.onProgress?.(`超分引擎不可用，已降级为 Lanczos（细节未增强）：${from} → ${to}`);
      } else {
        const budgetMs = opts.timeoutSec * 1000;
        const deadline = startedAt + budgetMs;
        const upscale = Math.min(ESRGAN_MAX_SCALE, Math.max(2, Math.ceil(Math.max(W / w, H / h))));
        // 尝试链：x4plus（质量优先，大 tile）→ x4fast（显存受限/低配 GPU 的中继降级，仍是真超分）
        const attempts: { model: string; tile: number }[] = status.fast
          ? [
              { model: ESRGAN_MODEL_MAIN, tile: ESRGAN_TILE },
              { model: ESRGAN_MODEL_FAST, tile: ESRGAN_TILE },
            ]
          : [
              { model: ESRGAN_MODEL_MAIN, tile: ESRGAN_TILE },
              { model: ESRGAN_MODEL_MAIN, tile: ESRGAN_FALLBACK_TILE },
            ];
        let lastError = '';
        for (let i = 0; i < attempts.length; i++) {
          const remaining = deadline - Date.now();
          if (remaining <= 1000) {
            lastError = '超分超出时间预算';
            break;
          }
          const { model, tile } = attempts[i];
          const label = model === ESRGAN_MODEL_FAST ? 'x4fast' : 'x4plus';
          opts.onProgress?.(`Real-ESRGAN（${label}）超分中（x${upscale}，第 ${i + 1}/${attempts.length} 次）…`);
          try {
            await runRealesrgan(status.exe, opts.srcPath, tmpEsrgan, upscale, tile, model, remaining, opts.signal);
            workPath = tmpEsrgan;
            engineUsed = 'realesrgan';
            engineModel = model;
            break;
          } catch (e) {
            if (opts.signal?.aborted) throw opts.signal.reason ?? e;
            lastError = e instanceof Error ? e.message : String(e);
            logLine('warn', `Real-ESRGAN ${label} 超分失败（第 ${i + 1} 次）：${lastError}`);
          }
        }
        if (engineUsed !== 'realesrgan') {
          degraded = true;
          degradeReason = lastError || '超分进程失败';
          opts.onProgress?.(`超分失败，已降级为 Lanczos（细节未增强）`);
        }
      }
    }

    const workMeta = await sharp(workPath).metadata();
    const ww = workMeta.width ?? 0;
    const wh = workMeta.height ?? 0;
    const aspectDiff = Math.abs(W / H - ww / wh) / (W / H);
    const cropped = aspectDiff > ASPECT_CROP_THRESHOLD;

    if (opts.origPath) {
      try {
        const icc = (await sharp(opts.origPath).metadata()).icc;
        if (icc && icc.length) {
          iccPath = path.join(path.dirname(opts.outPath), `.upscale_icc_${Date.now()}.icc`);
          fs.writeFileSync(iccPath, icc);
        }
      } catch {
        iccPath = undefined;
      }
    }

    opts.onProgress?.(cropped ? `宽高比偏差 ${(aspectDiff * 100).toFixed(1)}%，裁剪回填至 ${to}` : `回填至原图分辨率 ${to}`);
    let pipeline = sharp(workPath).resize(W, H, { fit: cropped ? 'cover' : 'fill', position: 'center' });
    if (iccPath) pipeline = pipeline.withMetadata({ icc: iccPath });
    await pipeline.png().toFile(opts.outPath);

    const finalMeta = await sharp(opts.outPath).metadata();
    if (finalMeta.width !== W || finalMeta.height !== H) {
      await sharp(workPath).resize(W, H, { fit: 'fill' }).png().toFile(opts.outPath);
      const retryMeta = await sharp(opts.outPath).metadata();
      if (retryMeta.width !== W || retryMeta.height !== H) {
        throw new MomoError('UPSCALE_FAILED', `超分回填后尺寸 ${retryMeta.width}x${retryMeta.height} 与原图 ${to} 不一致`);
      }
    }

    return {
      engine: engineUsed,
      ...(engineModel ? { model: engineModel } : {}),
      ...(degraded ? { degraded: true, degradeReason } : {}),
      from,
      to,
      scaleFactor: Number(scaleFactor.toFixed(3)),
      cropped,
      elapsedMs: Date.now() - startedAt,
      ...(iccPath ? { iccPreserved: true } : {}),
    };
  } finally {
    removePathQuiet(tmpEsrgan);
    if (iccPath) removePathQuiet(iccPath);
  }
}

/** 清理运行目录里遗留的超分临时文件（偶发被扫盘/索引占用导致删除失败时兜底） */
function sweepStaleTemp(dir: string): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.upscale_tmp_') || f.startsWith('.upscale_icc_')) {
        removePathQuiet(path.join(dir, f));
      }
    }
  } catch {
    /* ignore */
  }
}
