import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { badgeCenter, buildMarkerSvg, computeMarkerSpec, renderMarkers } from '../src/markers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-markers-'));
process.env.FXDESK_WORKSPACE = tmp;

describe('标记渲染器（§4.5 / 附录 B）', () => {
  it('规格：1000×1000 线宽 ≥4，徽章 ≥40', () => {
    const s = computeMarkerSpec(1000, 1000);
    expect(s.stroke).toBe(Math.max(4, Math.round(1000 * 0.004)));
    expect(s.badge).toBe(Math.max(40, Math.round(1000 * 0.035)));
    expect(s.stroke).toBe(4);
    expect(s.badge).toBe(40);
  });

  it('规格：4000×3000 等比计算', () => {
    const s = computeMarkerSpec(4000, 3000);
    expect(s.stroke).toBe(16);
    expect(s.badge).toBe(105);
    expect(s.fontSize).toBe(Math.round(105 * 0.55));
  });

  it('徽章位置：左上出界时移入框内并被夹取在图内', () => {
    const spec = computeMarkerSpec(1000, 1000);
    const c = badgeCenter({ x1: 2, y1: 2, x2: 200, y2: 200 }, spec, 1000, 1000);
    expect(c.cx).toBeGreaterThan(2);
    expect(c.cy).toBeGreaterThan(2);
    expect(c.cx - c.r).toBeGreaterThanOrEqual(0);
    expect(c.cy - c.r).toBeGreaterThanOrEqual(0);
  });

  it('SVG 包含规格线宽与颜色', () => {
    const svg = buildMarkerSvg(1000, 1000, [{ idx: 1, color: '#E53935', bbox: { x1: 100, y1: 100, x2: 400, y2: 400 } }]);
    expect(svg).toContain('stroke-width="4"');
    expect(svg).toContain('#E53935');
    expect(svg).toContain('fill-opacity="0.12"');
  });

  describe('渲染输出', () => {
    const baseDir = path.join(tmp, 'render');
    beforeAll(() => {
      fs.mkdirSync(baseDir, { recursive: true });
    });

    it('1000×1000 输出应有正确尺寸', async () => {
      const src = path.join(baseDir, 'a.png');
      await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#333' } }).png().toFile(src);
      const out = path.join(baseDir, 'markers_a.png');
      const r = await renderMarkers({
        srcPath: src,
        regions: [
          { idx: 1, color: '#E53935', bbox: { x1: 100, y1: 100, x2: 400, y2: 400 } },
          { idx: 2, color: '#FDD835', bbox: { x1: 500, y1: 500, x2: 800, y2: 800 } },
        ],
        outPath: out,
        sendMaxDimension: 4096,
      });
      expect(fs.existsSync(out)).toBe(true);
      expect(r.width).toBe(1000);
      expect(r.height).toBe(1000);
      expect(r.scale).toBe(1);
      const meta = await sharp(out).metadata();
      expect(meta.width).toBe(1000);
      expect(meta.format).toBe('png');
    });

    it('4000×3000 输出应有正确尺寸与线宽', async () => {
      const src = path.join(baseDir, 'b.png');
      await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#222' } }).png().toFile(src);
      const out = path.join(baseDir, 'markers_b.png');
      const r = await renderMarkers({
        srcPath: src,
        regions: [{ idx: 1, color: '#1E88E5', bbox: { x1: 400, y1: 400, x2: 1600, y2: 1200 } }],
        outPath: out,
        sendMaxDimension: 4096,
      });
      expect(r.width).toBe(4000);
      expect(r.height).toBe(3000);
    });

    it('超过发送长边上限时等比缩小且 bbox 同比例换算', async () => {
      const src = path.join(baseDir, 'c.png');
      await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#111' } }).png().toFile(src);
      const out = path.join(baseDir, 'markers_c.png');
      const r = await renderMarkers({
        srcPath: src,
        regions: [{ idx: 1, color: '#43A047', bbox: { x1: 1000, y1: 1000, x2: 2000, y2: 2000 } }],
        outPath: out,
        sendMaxDimension: 4096,
      });
      expect(r.width).toBe(4096);
      expect(r.height).toBe(Math.round(4000 * (4096 / 5000)));
      expect(r.scale).toBeCloseTo(4096 / 5000, 6);
    });
  });
});
