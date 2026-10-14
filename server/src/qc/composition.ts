import { createRequire } from 'node:module';
import sharp from 'sharp';
import type { QcComposition } from '../types';

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
function getSsim(): (img1: any, img2: any) => { mssim: number } {
  const m: any = require('ssim.js');
  if (typeof m === 'function') return m;
  if (typeof m.ssim === 'function') return m.ssim;
  if (m.default && typeof m.default === 'function') return m.default;
  if (m.default && typeof m.default.ssim === 'function') return m.default.ssim;
  throw new Error('ssim.js 加载失败');
}

async function toGrayRGBA(imgAbs: string, longSide = 512): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const meta = await sharp(imgAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const scale = Math.max(W, H) > longSide ? longSide / Math.max(W, H) : 1;
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const gray = await sharp(imgAbs).resize(w, h).greyscale().raw().toBuffer();
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = gray[i];
    rgba[i * 4 + 1] = gray[i];
    rgba[i * 4 + 2] = gray[i];
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: w, height: h };
}

/** SSIM（缩放至长边 512、灰度，ssim.js，取 mssim） */
export async function computeSsim(aAbs: string, bAbs: string): Promise<number> {
  const [a, b] = await Promise.all([toGrayRGBA(aAbs), toGrayRGBA(bAbs)]);
  const h = Math.min(a.height, b.height);
  const w = Math.min(a.width, b.width);
  const crop = (x: { data: Uint8ClampedArray; width: number; height: number }) => {
    if (x.width === w && x.height === h) return x;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x2 = 0; x2 < w; x2++) {
        const si = (y * x.width + x2) * 4;
        const di = (y * w + x2) * 4;
        d[di] = x.data[si];
        d[di + 1] = x.data[si + 1];
        d[di + 2] = x.data[si + 2];
        d[di + 3] = 255;
      }
    }
    return { data: d, width: w, height: h };
  };
  const ssimFn = getSsim();
  const res = ssimFn(crop(a), crop(b));
  return res.mssim;
}

/** pHash（256bit，DCT-II，imghash 同款算法；返回 1/0 位数组） */
export async function computePhash(imgAbs: string, hashSize = 16): Promise<boolean[]> {
  const N = 32;
  const gray = await sharp(imgAbs).resize(N, N, { fit: 'fill' }).greyscale().raw().toBuffer();
  const f = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = gray[i];

  const cosTable: number[][] = [];
  for (let u = 0; u < N; u++) {
    cosTable[u] = [];
    for (let x = 0; x < N; x++) cosTable[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }

  const tmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += f[y * N + x] * cosTable[u][x];
      tmp[y * N + u] = s;
    }
  }
  const dct = new Float64Array(N * N);
  for (let v = 0; v < N; v++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += tmp[y * N + x] * cosTable[v][y];
      dct[v * N + x] = s;
    }
  }

  const coeffs: number[] = [];
  for (let y = 0; y < hashSize; y++) {
    for (let x = 0; x < hashSize; x++) {
      if (x === 0 && y === 0) continue;
      coeffs.push(dct[y * N + x]);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits: boolean[] = [];
  for (let y = 0; y < hashSize; y++) {
    for (let x = 0; x < hashSize; x++) {
      if (x === 0 && y === 0) {
        bits.push(false);
        continue;
      }
      bits.push(dct[y * N + x] > median);
    }
  }
  return bits;
}

export function hammingDistance(a: boolean[], b: boolean[]): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** §4.7.2 构图检测：SSIM ≥ 0.55 且 pHash 距离 ≤ 16 通过 */
export async function analyzeComposition(aAbs: string, bAbs: string): Promise<QcComposition> {
  const [ssim, phA, phB] = await Promise.all([computeSsim(aAbs, bAbs), computePhash(aAbs), computePhash(bAbs)]);
  const phashDistance = hammingDistance(phA, phB);
  const verdict = ssim >= 0.55 && phashDistance <= 16 ? 'ok' : 'shifted';
  return { ssim: Number(ssim.toFixed(4)), phashDistance, verdict };
}
