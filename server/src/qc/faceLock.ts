import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { detectFaces, estimateSimilarity, pickFacePair, type Face } from './faces';
import { expandBox } from './faceRepair';
import type { Bbox } from '../types';

/** 锁脸参数（宽羽化 + 光照匹配，目标：不突兀、身份相似度 ≥ 0.95） */
export interface FaceLockOptions {
  origAbs: string;
  resultAbs: string;
  outAbs?: string;
  /** 取脸框外扩倍数（越大带入越多发型/背景，默认 1.7） */
  expandFactor?: number;
  /** 羽化带占蒙版半径比例（0~1，越大过渡越宽，默认 0.42） */
  featherRatio?: number;
  /** 是否做光照匹配（默认开启） */
  lightMatch?: boolean;
  /** 低频光照图强度 0~1（默认 0.7；太低会有“贴上去”的突兀感） */
  lightStrength?: number;
  /** 光照图在脸核心区的保留比例 0~1（默认 0.4）：0=核心不修正只修过渡带（最保身份），1=整脸修正 */
  lightCoreFloor?: number;
  /** 均值/方差色彩校正的强度 0~1（默认 0.4；过强会损失身份相似度） */
  lightGainStrength?: number;
  /** 羽化带“差异感知”抑制 0~1（默认 0.9）：带内原图与结果差异过大时让结果透出，避免叠影突兀 */
  edgeSuppress?: number;
  /** 对齐方式：auto 稳健校验（默认）；similarity 4 自由度；affine 6 自由度 */
  transform?: 'auto' | 'similarity' | 'affine';
  /** 脸太小（最短边低于该像素）时放弃，默认 56 */
  minFacePx?: number;
}

export interface FaceLockOutput {
  applied: boolean;
  reason?: string;
  lockedBuf?: Buffer;
  faceBoxOrig?: Bbox;
  faceBoxRes?: Bbox;
  expandedRes?: Bbox;
  /** 原图检测到的 5 点（用作复检采样点） */
  origKps?: [number, number][];
  /** 贴回后 5 点在结果图中的实际落点（warp 前向映射，复检用，避免检测器二次抖动） */
  placedKps?: [number, number][];
  /** 原图→结果 变换的等效旋转角（度）与缩放 */
  angleDeg?: number;
  scale?: number;
  /** 5 点对齐残差 / 双眼间距（越小越贴合，>0.15 提示姿态差异大） */
  alignResidual?: number;
  transform?: 'similarity' | 'affine';
  /** 关键点不可信、回退到稳健估计（脸框缩放 + 眼线角度） */
  guarded?: boolean;
  guardReason?: string;
  lightMatch?: boolean;
  gain?: [number, number, number];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

interface Raw {
  data: Buffer;
  W: number;
  H: number;
  ox: number;
  oy: number;
}

function sampleBilinear(raw: Raw, x: number, y: number, out: [number, number, number]): boolean {
  const lx = x - raw.ox;
  const ly = y - raw.oy;
  if (lx < 0 || ly < 0 || lx > raw.W - 1 || ly > raw.H - 1) return false;
  const x0 = Math.floor(lx);
  const y0 = Math.floor(ly);
  const x1 = Math.min(x0 + 1, raw.W - 1);
  const y1 = Math.min(y0 + 1, raw.H - 1);
  const fx = lx - x0;
  const fy = ly - y0;
  const idx = (xx: number, yy: number) => (yy * raw.W + xx) * 3;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);
  for (let c = 0; c < 3; c++) {
    out[c] =
      raw.data[i00 + c] * (1 - fx) * (1 - fy) +
      raw.data[i10 + c] * fx * (1 - fy) +
      raw.data[i01 + c] * (1 - fx) * fy +
      raw.data[i11 + c] * fx * fy;
  }
  return true;
}

async function loadRaw(absPath: string): Promise<Raw> {
  const meta = await sharp(absPath).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const data = await sharp(absPath).removeAlpha().raw().toBuffer();
  return { data, W, H, ox: 0, oy: 0 };
}

async function loadRawRegion(absPath: string, box: Bbox): Promise<Raw> {
  const data = await sharp(absPath)
    .removeAlpha()
    .extract({ left: box.x1, top: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 })
    .raw()
    .toBuffer();
  return { data, W: box.x2 - box.x1, H: box.y2 - box.y1, ox: box.x1, oy: box.y1 };
}

interface Warp {
  kind: 'similarity' | 'affine';
  fwd: (x: number, y: number) => [number, number];
  inv: (X: number, Y: number) => [number, number];
  angleDeg: number;
  scale: number;
}

function similarityWarp(t: { a: number; b: number; tx: number; ty: number }): Warp {
  const denom = t.a * t.a + t.b * t.b || 1;
  return {
    kind: 'similarity',
    fwd: (x, y) => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty],
    inv: (X, Y) => {
      const qx = X - t.tx;
      const qy = Y - t.ty;
      return [(t.a * qx + t.b * qy) / denom, (-t.b * qx + t.a * qy) / denom];
    },
    angleDeg: (Math.atan2(t.b, t.a) * 180) / Math.PI,
    scale: Math.sqrt(t.a * t.a + t.b * t.b) || 1,
  };
}

/** 最小二乘求解 3×3 线性方程组 M u = r（Cramer） */
function solve3(M: number[][], r: number[]): [number, number, number] | null {
  const det =
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const col = (c: number) => M.map((row, i) => row.map((v, j) => (j === c ? r[i] : v)));
  const d = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  return [d(col(0)) / det, d(col(1)) / det, d(col(2)) / det];
}

/** 5 点全仿射对齐（6 自由度）：q = A p + t，最小二乘 */
function fitAffine(src: [number, number][], dst: [number, number][]): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  const M: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rx = [0, 0, 0];
  const ry = [0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    const row = [src[i][0], src[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a][b] += row[a] * row[b];
      rx[a] += row[a] * dst[i][0];
      ry[a] += row[a] * dst[i][1];
    }
  }
  const ux = solve3(M, rx);
  const uy = solve3(M, ry);
  if (!ux || !uy) return null;
  return { a: ux[0], b: ux[1], c: ux[2], d: uy[0], e: uy[1], f: uy[2] };
}

function affineWarp(m: { a: number; b: number; c: number; d: number; e: number; f: number }): Warp {
  const det = m.a * m.e - m.b * m.d;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return similarityWarp({ a: 1, b: 0, tx: 0, ty: 0 });
  return {
    kind: 'affine',
    fwd: (x, y) => [m.a * x + m.b * y + m.c, m.d * x + m.e * y + m.f],
    inv: (X, Y) => {
      const qx = X - m.c;
      const qy = Y - m.f;
      return [(m.e * qx - m.b * qy) / det, (-m.d * qx + m.a * qy) / det];
    },
    angleDeg: (Math.atan2(m.d, m.a) * 180) / Math.PI,
    scale: Math.hypot(m.a, m.d) || 1,
  };
}

/** 结果图脸区与羽化蒙版（椭圆、宽过渡） */
function buildMask(box: Bbox, featherRatio: number): Float32Array {
  const W = box.x2 - box.x1;
  const H = box.y2 - box.y1;
  const cx = W / 2;
  const cy = H / 2;
  const rx = Math.max(4, W / 2);
  const ry = Math.max(4, H / 2);
  const mask = new Float32Array(W * H);
  const feather = clamp(featherRatio, 0.05, 0.85);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.sqrt(((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2);
      mask[y * W + x] = 1 - smoothstep(1 - feather, 1, d);
    }
  }
  return mask;
}

/** 对 RGB patch 做低通模糊（sharp，用于光照匹配的光照图） */
async function blurRGB(data: Buffer, W: number, H: number, sigma: number): Promise<Buffer> {
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).blur(Math.max(0.3, sigma)).raw().toBuffer();
}

function transformedBounds(w: Warp, box: Bbox): Bbox {
  const pts = (
    [
      [box.x1, box.y1],
      [box.x2, box.y1],
      [box.x1, box.y2],
      [box.x2, box.y2],
    ] as [number, number][]
  ).map(([x, y]) => w.inv(x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

function residualOf(src: [number, number][], dst: [number, number][], w: Warp): number {
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const [px, py] = w.fwd(src[i][0], src[i][1]);
    sum += Math.hypot(px - dst[i][0], py - dst[i][1]);
  }
  const interOcular = Math.hypot(dst[0][0] - dst[1][0], dst[0][1] - dst[1][1]) || 1;
  return sum / src.length / interOcular;
}

function normDeg(d: number): number {
  return (((d + 540) % 360) - 180);
}

function centroidOf(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0] / pts.length;
    y += p[1] / pts.length;
  }
  return [x, y];
}

function similarityFrom(s: number, thetaDeg: number, srcC: [number, number], dstC: [number, number]): Warp {
  const rad = (thetaDeg * Math.PI) / 180;
  const a = s * Math.cos(rad);
  const b = s * Math.sin(rad);
  return similarityWarp({
    a,
    b,
    tx: dstC[0] - (a * srcC[0] - b * srcC[1]),
    ty: dstC[1] - (b * srcC[0] + a * srcC[1]),
  });
}

/**
 * 稳健对齐（auto）：以 5 点相似拟合为基准，但用“脸框缩放 + 眼线角度”交叉校验；
 * 表情/姿态差异大（闭眼↔睁眼等）导致关键点不可信时回退到稳健估计，避免把脸拉歪。
 */
function chooseWarp(orig: Face, res: Face): { warp: Warp; guarded: boolean; reason?: string } {
  const fitted = similarityWarp(estimateSimilarity(orig.kps, res.kps));
  const ow = Math.max(8, orig.box.x2 - orig.box.x1);
  const oh = Math.max(8, orig.box.y2 - orig.box.y1);
  const rw = Math.max(8, res.box.x2 - res.box.x1);
  const rh = Math.max(8, res.box.y2 - res.box.y1);
  const boxScale = (rw / ow + rh / oh) / 2;
  const eyeAngle = (kps: [number, number][]) => (Math.atan2(kps[1][1] - kps[0][1], kps[1][0] - kps[0][0]) * 180) / Math.PI;
  const eyeDelta = clamp(normDeg(eyeAngle(res.kps) - eyeAngle(orig.kps)), -15, 15);

  let s = fitted.scale;
  let theta = normDeg(fitted.angleDeg);
  let guarded = false;
  let reason: string | undefined;
  if (Math.abs(s / boxScale - 1) > 0.12) {
    s = boxScale;
    guarded = true;
    reason = 'scale_guard';
  }
  if (Math.abs(normDeg(theta - eyeDelta)) > 10) {
    theta = eyeDelta;
    guarded = true;
    reason = reason ? `${reason}+angle_guard` : 'angle_guard';
  }
  if (!guarded) return { warp: fitted, guarded: false };
  s = clamp(s, boxScale * 0.85, boxScale * 1.15);
  theta = clamp(theta, -20, 20);
  if (!Number.isFinite(s) || !Number.isFinite(theta) || s <= 0) {
    return { warp: similarityFrom(boxScale, 0, centroidOf(orig.kps), centroidOf(res.kps)), guarded: true, reason: 'fallback' };
  }
  return { warp: similarityFrom(s, theta, centroidOf(orig.kps), centroidOf(res.kps)), guarded: true, reason };
}

/**
 * 面部图层锁定：原图脸区按 5 点对齐（相似/仿射变换）贴到结果图脸位，宽羽化 + 光照匹配。
 * 这是交付前最后一步；产物为原图全分辨率像素，身份相似度可达 0.95+。
 */
export async function applyFaceLock(opts: FaceLockOptions): Promise<FaceLockOutput> {
  const expandFactor = opts.expandFactor ?? 1.7;
  const featherRatio = opts.featherRatio ?? 0.42;
  const lightMatch = opts.lightMatch !== false;
  const lightStrength = clamp(opts.lightStrength ?? 0.7, 0, 1);
  const lightCoreFloor = clamp(opts.lightCoreFloor ?? 0.4, 0, 1);
  const lightGainStrength = clamp(opts.lightGainStrength ?? 0.4, 0, 1);
  const edgeSuppress = clamp(opts.edgeSuppress ?? 0.9, 0, 1);
  const minFacePx = opts.minFacePx ?? 56;

  const [of, rf] = await Promise.all([detectFaces(opts.origAbs), detectFaces(opts.resultAbs)]);
  const pair = pickFacePair(of, rf);
  if (!pair) return { applied: false, reason: 'no_face' };

  const faceW = pair.res.box.x2 - pair.res.box.x1;
  const faceH = pair.res.box.y2 - pair.res.box.y1;
  if (Math.min(faceW, faceH) < minFacePx) return { applied: false, reason: 'face_too_small' };

  const rMeta = await sharp(opts.resultAbs).metadata();
  const oMeta = await sharp(opts.origAbs).metadata();
  const rW = rMeta.width ?? 0;
  const rH = rMeta.height ?? 0;
  const oW = oMeta.width ?? 0;
  const oH = oMeta.height ?? 0;

  const mode = opts.transform ?? 'auto';
  let warp: Warp;
  let guarded = false;
  let guardReason: string | undefined;
  if (mode === 'affine') {
    warp = similarityWarp(estimateSimilarity(pair.orig.kps, pair.res.kps));
    const aff = fitAffine(pair.orig.kps, pair.res.kps);
    if (aff) {
      const s1 = Math.hypot(aff.a, aff.d);
      const s2 = Math.hypot(aff.b, aff.e);
      const sMin = Math.min(s1, s2);
      const sMax = Math.max(s1, s2);
      if (sMin > 0.5 && sMax < 2 && (aff.a * aff.e - aff.b * aff.d) * (warp.scale ** 2) > 0) warp = affineWarp(aff);
    }
  } else if (mode === 'similarity') {
    warp = similarityWarp(estimateSimilarity(pair.orig.kps, pair.res.kps));
  } else {
    const chosen = chooseWarp(pair.orig, pair.res);
    warp = chosen.warp;
    guarded = chosen.guarded;
    guardReason = chosen.reason;
  }
  const angleDeg = warp.angleDeg;
  const scale = warp.scale;
  const alignResidual = residualOf(pair.orig.kps, pair.res.kps, warp);

  const expandedRes = expandBox(pair.res.box, expandFactor, rW, rH);
  const patchW = expandedRes.x2 - expandedRes.x1;
  const patchH = expandedRes.y2 - expandedRes.y1;

  const srcBounds = transformedBounds(warp, expandedRes);
  const srcBox: Bbox = {
    x1: clamp(Math.floor(srcBounds.x1) - 2, 0, Math.max(0, oW - 1)),
    y1: clamp(Math.floor(srcBounds.y1) - 2, 0, Math.max(0, oH - 1)),
    x2: clamp(Math.ceil(srcBounds.x2) + 2, 1, oW),
    y2: clamp(Math.ceil(srcBounds.y2) + 2, 1, oH),
  };
  if (srcBox.x2 - srcBox.x1 < 8 || srcBox.y2 - srcBox.y1 < 8) return { applied: false, reason: 'align_out_of_bounds' };

  const [srcRaw, resRaw] = await Promise.all([loadRawRegion(opts.origAbs, srcBox), loadRawRegion(opts.resultAbs, expandedRes)]);
  const mask = buildMask(expandedRes, featherRatio);

  const warped = Buffer.alloc(patchW * patchH * 3);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < patchH; y++) {
    const Y = expandedRes.y1 + y + 0.5;
    for (let x = 0; x < patchW; x++) {
      const X = expandedRes.x1 + x + 0.5;
      const i = (y * patchW + x) * 3;
      const [ux, uy] = warp.inv(X, Y);
      if (sampleBilinear(srcRaw, ux, uy, rgb)) {
        warped[i] = rgb[0];
        warped[i + 1] = rgb[1];
        warped[i + 2] = rgb[2];
      } else {
        const m = mask[y * patchW + x];
        warped[i] = resRaw.data[i];
        warped[i + 1] = resRaw.data[i + 1];
        warped[i + 2] = resRaw.data[i + 2];
        mask[y * patchW + x] = m * 0; // 源越界处不贴
      }
    }
  }

  let corrected = warped;
  let gainTri: [number, number, number] | undefined;
  if (lightMatch) {
    // 1) 脸核心区均值/方差对齐（修正整体色偏与明暗差）
    const means = (buf: Buffer) => {
      const sum = [0, 0, 0];
      const sum2 = [0, 0, 0];
      let n = 0;
      for (let p = 0; p < patchW * patchH; p++) {
        if (mask[p] < 0.999) continue;
        const i = p * 3;
        for (let c = 0; c < 3; c++) {
          sum[c] += buf[i + c];
          sum2[c] += buf[i + c] * buf[i + c];
        }
        n++;
      }
      const mean = [0, 0, 0];
      const std = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        mean[c] = n ? sum[c] / n : 0;
        const v = n ? sum2[c] / n - mean[c] * mean[c] : 0;
        std[c] = Math.sqrt(Math.max(0, v));
      }
      return { mean, std, n };
    };
    const st = means(resRaw.data);
    const sw = means(warped);
    if (st.n > 128 && sw.n > 128) {
      const gain: [number, number, number] = [1, 1, 1];
      const off: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        gain[c] = clamp(sw.std[c] > 1e-3 ? st.std[c] / sw.std[c] : 1, 0.55, 1.8);
        off[c] = st.mean[c] - gain[c] * sw.mean[c];
        gain[c] = 1 + (gain[c] - 1) * lightGainStrength;
        off[c] = off[c] * lightGainStrength;
      }
      gainTri = gain;
      const matched = Buffer.alloc(warped.length);
      for (let i = 0; i < warped.length; i++) {
        const c = i % 3;
        matched[i] = clamp(warped[i] * gain[c] + off[c], 0, 255);
      }

      // 2) 低频光照图：把结果图脸区的局部受光（方向光/环境光）叠加到贴片上
      if (lightStrength > 0) {
        const sigma = Math.max(4, Math.min(patchW, patchH) / 22);
        const [blurT, blurW] = await Promise.all([
          blurRGB(resRaw.data, patchW, patchH, sigma),
          blurRGB(matched, patchW, patchH, sigma),
        ]);
        corrected = Buffer.alloc(warped.length);
        for (let p = 0; p < patchW * patchH; p++) {
          // 光照图按位置加权：脸核心只施加 lightCoreFloor（保身份），过渡带全量（防突兀）
          const w = lightStrength * (lightCoreFloor + (1 - lightCoreFloor) * (1 - mask[p]));
          const i = p * 3;
          corrected[i] = clamp(matched[i] + (blurT[i] - blurW[i]) * w, 0, 255);
          corrected[i + 1] = clamp(matched[i + 1] + (blurT[i + 1] - blurW[i + 1]) * w, 0, 255);
          corrected[i + 2] = clamp(matched[i + 2] + (blurT[i + 2] - blurW[i + 2]) * w, 0, 255);
        }
      } else {
        corrected = matched;
      }
    }
  }

  // 羽化带“差异感知”抑制：带内原图与结果内容差异过大（发色/发型被模型改动等）时让结果透出，
  // 避免旧内容半透明叠影显得突兀；脸核心（alpha=1）不受影响，身份相似度不受损。
  if (edgeSuppress > 0) {
    for (let p = 0; p < patchW * patchH; p++) {
      const a = mask[p];
      if (a <= 0 || a >= 0.999) continue;
      const i = p * 3;
      const diff =
        (Math.abs(warped[i] - resRaw.data[i]) +
          Math.abs(warped[i + 1] - resRaw.data[i + 1]) +
          Math.abs(warped[i + 2] - resRaw.data[i + 2])) /
        3;
      const d = smoothstep(14, 72, diff);
      if (d > 0) mask[p] = clamp(a * (1 - edgeSuppress * (1 - a) * d), 0, 1);
    }
  }

  const patch = Buffer.alloc(patchW * patchH * 4);
  for (let p = 0; p < patchW * patchH; p++) {
    const a = mask[p];
    const i3 = p * 3;
    const i4 = p * 4;
    patch[i4] = corrected[i3];
    patch[i4 + 1] = corrected[i3 + 1];
    patch[i4 + 2] = corrected[i3 + 2];
    patch[i4 + 3] = Math.round(clamp(a, 0, 1) * 255);
  }

  const lockedBuf = await sharp(opts.resultAbs)
    .composite([
      {
        input: patch,
        raw: { width: patchW, height: patchH, channels: 4 },
        left: expandedRes.x1,
        top: expandedRes.y1,
      },
    ])
    .png()
    .toBuffer();

  if (opts.outAbs) {
    fs.mkdirSync(path.dirname(opts.outAbs), { recursive: true });
    fs.writeFileSync(opts.outAbs, lockedBuf);
  }

  return {
    applied: true,
    lockedBuf,
    faceBoxOrig: pair.orig.box,
    faceBoxRes: pair.res.box,
    expandedRes,
    origKps: pair.orig.kps,
    placedKps: pair.orig.kps.map(([x, y]) => warp.fwd(x, y)),
    angleDeg: Number(angleDeg.toFixed(2)),
    scale: Number(scale.toFixed(4)),
    alignResidual: Number(alignResidual.toFixed(4)),
    transform: warp.kind,
    guarded,
    guardReason,
    lightMatch,
    gain: gainTri,
  };
}
