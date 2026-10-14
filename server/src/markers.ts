import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { PALETTE, normalizeHex } from './prompt';
import type { Bbox } from './types';

export interface MarkerRegion {
  idx: number;
  color: string;
  bbox: Bbox;
}

export interface MarkerSpec {
  stroke: number;
  badge: number;
  fontSize: number;
}

/** 附录 B：线条/徽章尺寸按图像尺寸等比 */
export function computeMarkerSpec(W: number, H: number): MarkerSpec {
  const long = Math.max(W, H);
  const short = Math.min(W, H);
  const stroke = Math.max(4, Math.round(long * 0.004));
  const badge = Math.max(40, Math.round(short * 0.035));
  const fontSize = Math.round(badge * 0.55);
  return { stroke, badge, fontSize };
}

/** 徽章圆心：默认放框左上角外侧，出界则移到框内角；最终夹取在图内 */
export function badgeCenter(bbox: Bbox, spec: MarkerSpec, W: number, H: number): { cx: number; cy: number; r: number } {
  const r = spec.badge / 2;
  const gap = spec.stroke + 2;
  let cx = bbox.x1 - gap - r;
  let cy = bbox.y1 - gap - r;
  if (cx - r < 0) cx = bbox.x1 + gap + r;
  if (cy - r < 0) cy = bbox.y1 + gap + r;
  cx = Math.min(Math.max(cx, r), W - r);
  cy = Math.min(Math.max(cy, r), H - r);
  return { cx, cy, r };
}

export function scaleBbox(b: Bbox, scale: number): Bbox {
  return { ...b, x1: b.x1 * scale, y1: b.y1 * scale, x2: b.x2 * scale, y2: b.y2 * scale };
}

export function buildMarkerSvg(W: number, H: number, regions: MarkerRegion[]): string {
  const spec = computeMarkerSpec(W, H);
  const parts: string[] = [];
  for (const r of regions) {
    const color = normalizeHex(r.color || PALETTE[(r.idx - 1) % PALETTE.length]);
    const b = r.bbox;
    const x = Math.min(b.x1, b.x2);
    const y = Math.min(b.y1, b.y2);
    const w = Math.abs(b.x2 - b.x1);
    const h = Math.abs(b.y2 - b.y1);
    if (w < 1 || h < 1) continue;

    if (b.shape === 'ellipse') {
      parts.push(`<ellipse cx="${(x + w / 2).toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${spec.stroke}" />`);
    } else if ((b.shape === 'polygon' || b.shape === 'lasso') && b.points?.length) {
      const points = b.points.map((p) => `${(x + p.x * w).toFixed(1)},${(y + p.y * h).toFixed(1)}`).join(' ');
      parts.push(`<polygon points="${points}" fill="none" stroke="${color}" stroke-width="${spec.stroke}" stroke-linejoin="round" />`);
    } else {
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
          `fill="none" stroke="${color}" stroke-width="${spec.stroke}" />`
      );

      // 角标（2 倍线宽，可选增强可见性）
      const cw = spec.stroke * 2;
      const cl = spec.stroke * 4;
      const corners: [number, number, number, number][] = [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ];
      for (const [cx0, cy0, sx, sy] of corners) {
        parts.push(
          `<path d="M ${cx0 + sx * cl} ${cy0} L ${cx0} ${cy0} L ${cx0} ${cy0 + sy * cl}" ` +
            `fill="none" stroke="${color}" stroke-width="${cw}" />`
        );
      }
    }

    const { cx, cy, r: radius } = badgeCenter(b, spec, W, H);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" />`);
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="${spec.fontSize}" ` +
        `font-weight="bold" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">${r.idx}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('\n')}</svg>`;
}

export interface RenderMarkersResult {
  outPath: string;
  width: number;
  height: number;
  scale: number;
}

/** §4.5 标记渲染器：对原图副本渲染（不改原文件），输出 PNG */
export async function renderMarkers(opts: {
  srcPath: string;
  regions: MarkerRegion[];
  outPath: string;
  sendMaxDimension: number;
}): Promise<RenderMarkersResult> {
  const meta = await sharp(opts.srcPath).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (!origW || !origH) throw new Error('无法读取原图尺寸');

  const longDim = Math.max(origW, origH);
  const scale = longDim > opts.sendMaxDimension ? opts.sendMaxDimension / longDim : 1;
  const outW = Math.max(1, Math.round(origW * scale));
  const outH = Math.max(1, Math.round(origH * scale));

  const regions = opts.regions.map((r) => ({ ...r, bbox: scaleBbox(r.bbox, scale) }));
  const svg = buildMarkerSvg(outW, outH, regions);

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  let img = sharp(opts.srcPath);
  if (scale !== 1) img = img.resize(outW, outH);
  await img
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(opts.outPath);

  return { outPath: opts.outPath, width: outW, height: outH, scale };
}
