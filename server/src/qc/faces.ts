import fs from 'node:fs';
import sharp from 'sharp';
import { ws } from '../env';
import { logLine } from '../logger';
import type { Bbox } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type ORTMod = any;
let ortPromise: Promise<ORTMod | null> | null = null;

async function loadOrt(): Promise<ORTMod | null> {
  if (!ortPromise) {
    ortPromise = (async () => {
      try {
        const m: any = await import('onnxruntime-node');
        return m?.default ?? m;
      } catch (e) {
        logLine('warn', 'onnxruntime-node 不可用（身份质检将降级为人工目检）', String(e));
        return null;
      }
    })();
  }
  return ortPromise;
}

export interface ModelsStatus {
  dir: string;
  det: boolean;
  rec: boolean;
  ok: boolean;
}

export function modelsStatus(): ModelsStatus {
  const detPath = ws('models', 'det_10g.onnx');
  const recPath = ws('models', 'w600k_r50.onnx');
  const det = fs.existsSync(detPath);
  const rec = fs.existsSync(recPath);
  return { dir: ws('models'), det, rec, ok: det && rec };
}

let sessionsPromise: Promise<{ O: ORTMod; det: any; rec: any }> | null = null;

async function ensureSessions(): Promise<{ O: ORTMod; det: any; rec: any }> {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const st = modelsStatus();
      if (!st.ok) throw new Error('MODELS_MISSING');
      const O = await loadOrt();
      if (!O) throw new Error('ORT_MISSING');
      const det = await O.InferenceSession.create(ws('models', 'det_10g.onnx'), { executionProviders: ['cpu'] });
      const rec = await O.InferenceSession.create(ws('models', 'w600k_r50.onnx'), { executionProviders: ['cpu'] });
      return { O, det, rec };
    })();
  }
  try {
    return await sessionsPromise;
  } catch (e) {
    sessionsPromise = null; // 允许下次重试
    throw e;
  }
}

export interface Face {
  score: number;
  box: Bbox;
  kps: [number, number][];
}

const DET_SIZE = 640;

/** SCRFD (det_10g) 人脸检测：置信度 ≥ 0.5，返回原图像素坐标 */
export async function detectFaces(imgAbs: string): Promise<Face[]> {
  const { O, det } = await ensureSessions();
  const meta = await sharp(imgAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;

  const raw = await sharp(imgAbs).removeAlpha().resize(DET_SIZE, DET_SIZE, { fit: 'fill' }).raw().toBuffer();
  const n = DET_SIZE * DET_SIZE;
  const tensor = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    tensor[i] = (raw[i * 3] - 127.5) / 128;
    tensor[n + i] = (raw[i * 3 + 1] - 127.5) / 128;
    tensor[2 * n + i] = (raw[i * 3 + 2] - 127.5) / 128;
  }

  const inputName = det.inputNames[0];
  const out = await det.run({ [inputName]: new O.Tensor('float32', tensor, [1, 3, DET_SIZE, DET_SIZE]) });

  const anchorCounts: Record<number, number> = { 8: 12800, 16: 3200, 32: 800 };
  interface Group {
    stride: number;
    scores?: Float32Array;
    bbox?: Float32Array;
    kps?: Float32Array;
  }
  const groups: Record<number, Group> = { 8: { stride: 8 }, 16: { stride: 16 }, 32: { stride: 32 } };

  for (const key of Object.keys(out)) {
    const t = out[key];
    const dims: number[] = t.dims;
    const last = dims[dims.length - 1];
    const numAnchors = dims[dims.length - 2];
    let stride = 0;
    for (const [s, cnt] of Object.entries(anchorCounts)) {
      if (cnt === numAnchors) stride = Number(s);
    }
    if (!stride) continue;
    const data = t.data as Float32Array;
    if (last === 1) groups[stride].scores = data;
    else if (last === 4) groups[stride].bbox = data;
    else if (last === 10) groups[stride].kps = data;
  }

  const faces: Face[] = [];
  for (const g of Object.values(groups)) {
    if (!g.scores || !g.bbox || !g.kps) continue;
    const { stride, scores, bbox, kps } = g;
    const fm = DET_SIZE / stride;
    const anchors = 2;
    const num = fm * fm * anchors;
    for (let idx = 0; idx < num; idx++) {
      const score = scores[idx];
      if (score < 0.5) continue;
      const i = Math.floor(idx / (fm * anchors));
      const j = Math.floor((idx % (fm * anchors)) / anchors);
      const cx = j * stride;
      const cy = i * stride;
      const x1 = cx - bbox[idx * 4] * stride;
      const y1 = cy - bbox[idx * 4 + 1] * stride;
      const x2 = cx + bbox[idx * 4 + 2] * stride;
      const y2 = cy + bbox[idx * 4 + 3] * stride;
      const pts: [number, number][] = [];
      for (let k = 0; k < 5; k++) {
        pts.push([cx + kps[idx * 10 + k * 2] * stride, cy + kps[idx * 10 + k * 2 + 1] * stride]);
      }
      faces.push({
        score,
        box: {
          x1: (x1 / DET_SIZE) * W,
          y1: (y1 / DET_SIZE) * H,
          x2: (x2 / DET_SIZE) * W,
          y2: (y2 / DET_SIZE) * H,
        },
        kps: pts.map(([px, py]) => [(px / DET_SIZE) * W, (py / DET_SIZE) * H] as [number, number]),
      });
    }
  }

  return nms(faces, 0.4);
}

function iou(a: Bbox, b: Bbox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const denom = areaA + areaB - inter;
  return denom <= 0 ? 0 : inter / denom;
}

function nms(faces: Face[], thresh: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of sorted) {
    if (kept.every((k) => iou(k.box, f.box) < thresh)) kept.push(f);
  }
  return kept;
}

const ARC_TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export interface Similarity2D {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** 最小二乘相似变换：q = [[a,-b],[b,a]] p + t */
export function estimateSimilarity(src: [number, number][], dst: [number, number][]): Similarity2D {
  const nP = src.length;
  const meanS: [number, number] = [0, 0];
  const meanD: [number, number] = [0, 0];
  for (let i = 0; i < nP; i++) {
    meanS[0] += src[i][0] / nP;
    meanS[1] += src[i][1] / nP;
    meanD[0] += dst[i][0] / nP;
    meanD[1] += dst[i][1] / nP;
  }
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < nP; i++) {
    const sx = src[i][0] - meanS[0];
    const sy = src[i][1] - meanS[1];
    const dx = dst[i][0] - meanD[0];
    const dy = dst[i][1] - meanD[1];
    num1 += sx * dx + sy * dy;
    num2 += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  const a = den ? num1 / den : 1;
  const b = den ? num2 / den : 0;
  const tx = meanD[0] - (a * meanS[0] - b * meanS[1]);
  const ty = meanD[1] - (b * meanS[0] + a * meanS[1]);
  return { a, b, tx, ty };
}

function bilinear(data: Buffer, W: number, H: number, x: number, y: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, W - 1);
  const y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0;
  const fy = y - y0;
  const px = (xx: number, yy: number, c: number) => data[(yy * W + xx) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      px(x0, y0, c) * (1 - fx) * (1 - fy) +
      px(x1, y0, c) * fx * (1 - fy) +
      px(x0, y1, c) * (1 - fx) * fy +
      px(x1, y1, c) * fx * fy;
  }
  return out;
}

/** 5 点对齐到 ArcFace 模板 → 112×112 → 512 维特征（L2 归一化） */
export async function embedFace(imgAbs: string, kps: [number, number][]): Promise<Float32Array> {
  const { O, rec } = await ensureSessions();
  const meta = await sharp(imgAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const raw = await sharp(imgAbs).removeAlpha().raw().toBuffer();

  const t = estimateSimilarity(kps, ARC_TEMPLATE);
  const denom = t.a * t.a + t.b * t.b || 1;
  const SIZE = 112;
  const out = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const qx = x - t.tx;
      const qy = y - t.ty;
      const px = (t.a * qx + t.b * qy) / denom;
      const py = (-t.b * qx + t.a * qy) / denom;
      const rgb = bilinear(raw, W, H, px, py) ?? [0, 0, 0];
      const idx = y * SIZE + x;
      out[idx] = (rgb[0] - 127.5) / 128;
      out[SIZE * SIZE + idx] = (rgb[1] - 127.5) / 128;
      out[2 * SIZE * SIZE + idx] = (rgb[2] - 127.5) / 128;
    }
  }

  const inputName = rec.inputNames[0];
  const res = await rec.run({ [inputName]: new O.Tensor('float32', out, [1, 3, SIZE, SIZE]) });
  const key = rec.outputNames[0];
  const vec = res[key].data as Float32Array;
  return l2normalize(vec);
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 原图取最大人脸；结果图取中心距最小者（§C.1） */
export function pickFacePair(origFaces: Face[], resFaces: Face[]): { orig: Face; res: Face } | null {
  if (!origFaces.length || !resFaces.length) return null;
  const orig = [...origFaces].sort(
    (a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1)
  )[0];
  const oc = { x: (orig.box.x1 + orig.box.x2) / 2, y: (orig.box.y1 + orig.box.y2) / 2 };
  const nearest = [...resFaces]
    .map((f) => {
      const c = { x: (f.box.x1 + f.box.x2) / 2, y: (f.box.y1 + f.box.y2) / 2 };
      return { f, d: (c.x - oc.x) ** 2 + (c.y - oc.y) ** 2 };
    })
    .sort((a, b) => a.d - b.d)[0];
  return nearest ? { orig, res: nearest.f } : null;
}
