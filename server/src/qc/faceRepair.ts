import sharp from 'sharp';
import { detectFaces, pickFacePair } from './faces';
import { generateWithFallback } from '../momo';
import { loadSettings } from '../settings';
import type { Bbox } from '../types';

export interface FaceRepairOutput {
  repairedBuf: Buffer;
  rawBase64: string;
  rawMime: string;
  faceBoxOrig: Bbox;
  faceBoxRes: Bbox;
  expandedRes: Bbox;
  mocked: boolean;
}

export function expandBox(b: Bbox, factor: number, W: number, H: number): Bbox {
  const cx = (b.x1 + b.x2) / 2;
  const cy = (b.y1 + b.y2) / 2;
  const w = (b.x2 - b.x1) * factor;
  const h = (b.y2 - b.y1) * factor;
  const x1 = Math.max(0, Math.floor(cx - w / 2));
  const y1 = Math.max(0, Math.floor(cy - h / 2));
  const x2 = Math.min(W, Math.ceil(cx + w / 2));
  const y2 = Math.min(H, Math.ceil(cy + h / 2));
  return { x1, y1, x2: Math.max(x2, x1 + 8), y2: Math.max(y2, y1 + 8) };
}

async function shrinkTo(buf: Buffer, maxDim: number): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const long = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (long <= maxDim) return buf;
  return sharp(buf).resize({ width: meta.width! >= meta.height! ? maxDim : undefined, height: meta.height! > meta.width! ? maxDim : undefined, fit: 'inside' }).png().toBuffer();
}

/** §4.7.4 面部重修：结果图脸区 + 原图脸区（参考图1）→ 修复裁片 → 羽化椭圆合成回结果图 */
export async function performFaceRepair(opts: { origAbs: string; resultAbs: string; signal?: AbortSignal }): Promise<FaceRepairOutput> {
  const settings = loadSettings();
  const [of, rf] = await Promise.all([detectFaces(opts.origAbs), detectFaces(opts.resultAbs)]);
  const pair = pickFacePair(of, rf);
  if (!pair) throw new Error('未检测到人脸，无法面部重修');

  const rMeta = await sharp(opts.resultAbs).metadata();
  const oMeta = await sharp(opts.origAbs).metadata();
  const rW = rMeta.width ?? 0;
  const rH = rMeta.height ?? 0;
  const oW = oMeta.width ?? 0;
  const oH = oMeta.height ?? 0;

  const expandedRes = expandBox(pair.res.box, 2, rW, rH);
  const expandedOrig: Bbox = {
    x1: Math.max(0, Math.floor((expandedRes.x1 / rW) * oW)),
    y1: Math.max(0, Math.floor((expandedRes.y1 / rH) * oH)),
    x2: Math.min(oW, Math.ceil((expandedRes.x2 / rW) * oW)),
    y2: Math.min(oH, Math.ceil((expandedRes.y2 / rH) * oH)),
  };

  const resCropW = expandedRes.x2 - expandedRes.x1;
  const resCropH = expandedRes.y2 - expandedRes.y1;
  const origCropW = Math.max(8, expandedOrig.x2 - expandedOrig.x1);
  const origCropH = Math.max(8, expandedOrig.y2 - expandedOrig.y1);

  const resCrop = await sharp(opts.resultAbs)
    .extract({ left: expandedRes.x1, top: expandedRes.y1, width: resCropW, height: resCropH })
    .png()
    .toBuffer();
  const origCrop = await sharp(opts.origAbs)
    .extract({ left: expandedOrig.x1, top: expandedOrig.y1, width: origCropW, height: origCropH })
    .png()
    .toBuffer();

  const resCropSend = await shrinkTo(resCrop, 1024);
  const origCropSend = await shrinkTo(origCrop, 1024);

  const gen = await generateWithFallback({
    images: [
      { mime: 'image/png', base64: resCropSend.toString('base64') },
      { mime: 'image/png', base64: origCropSend.toString('base64') },
    ],
    prompt: settings.tplFaceRepair,
    signal: opts.signal,
    settings,
    mockReturn: { mime: 'image/png', base64: origCropSend.toString('base64') },
  });

  const repaired = await sharp(Buffer.from(gen.base64, 'base64'))
    .resize(resCropW, resCropH, { fit: 'fill' })
    .png()
    .toBuffer();

  const rx = Math.max(12, (resCropW / 2) * 1.1);
  const ry = Math.max(12, (resCropH / 2) * 1.1);
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${resCropW}" height="${resCropH}"><ellipse cx="${resCropW / 2}" cy="${resCropH / 2}" rx="${rx}" ry="${ry}" fill="#ffffff"/></svg>`;
  const maskPng = await sharp(Buffer.from(maskSvg)).blur(30).png().toBuffer();

  const masked = await sharp(repaired)
    .ensureAlpha()
    .composite([{ input: maskPng, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const composited = await sharp(opts.resultAbs)
    .composite([{ input: masked, left: expandedRes.x1, top: expandedRes.y1 }])
    .png()
    .toBuffer();

  return {
    repairedBuf: composited,
    rawBase64: gen.base64,
    rawMime: gen.mime,
    faceBoxOrig: pair.orig.box,
    faceBoxRes: pair.res.box,
    expandedRes,
    mocked: !!gen.mocked,
  };
}
