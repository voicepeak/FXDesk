import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-upscale-'));
process.env.FXDESK_WORKSPACE = tmp;

const { upscaleToOriginal, upscalerStatus } = await import('../src/upscale');

async function makeImg(file: string, w: number, h: number): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 80, g: 120, b: 200 } } }).png().toFile(file);
}

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('超分回填（§4.6.8 / §12.2）', () => {
  it('模型输出 3392×5056 + 原图 4096×6144 → 输出精确 4096×6144', async () => {
    const src = path.join(tmp, 'r1.png');
    const out = path.join(tmp, 'o1.png');
    const orig = path.join(tmp, 'orig1.png');
    await makeImg(src, 3392, 5056);
    await makeImg(orig, 4096, 6144);
    const rec = await upscaleToOriginal({ srcPath: src, outPath: out, origPath: orig, origW: 4096, origH: 6144, engine: 'lanczos', timeoutSec: 120 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(4096);
    expect(meta.height).toBe(6144);
    expect(rec.engine).toBe('lanczos');
    expect(rec.cropped).toBe(false);
    expect(rec.from).toBe('3392x5056');
    expect(rec.to).toBe('4096x6144');
    expect(rec.scaleFactor).toBeCloseTo(1.215, 2);
  });

  it('尺寸差距 ≤5% 时直接走 Lanczos 分支（即使选择 realesrgan）', async () => {
    const src = path.join(tmp, 'r2.png');
    const out = path.join(tmp, 'o2.png');
    await makeImg(src, 4000, 6000);
    const rec = await upscaleToOriginal({ srcPath: src, outPath: out, origW: 4096, origH: 6144, engine: 'realesrgan', timeoutSec: 60 });
    expect(rec.engine).toBe('lanczos');
    expect(rec.degraded).toBeUndefined();
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([4096, 6144]);
  });

  it('引擎缺失时自动降级 Lanczos 并标注原因', async () => {
    const missingDir = path.join(tmp, 'no-such-engine');
    const prev = process.env.FXDESK_UPSCALER_DIR;
    process.env.FXDESK_UPSCALER_DIR = missingDir;
    expect(upscalerStatus().ok).toBe(false);
    const src = path.join(tmp, 'r3.png');
    const out = path.join(tmp, 'o3.png');
    await makeImg(src, 2000, 3000);
    const rec = await upscaleToOriginal({ srcPath: src, outPath: out, origW: 4096, origH: 6144, engine: 'realesrgan', timeoutSec: 60 });
    if (prev === undefined) delete process.env.FXDESK_UPSCALER_DIR;
    else process.env.FXDESK_UPSCALER_DIR = prev;
    expect(rec.engine).toBe('lanczos');
    expect(rec.degraded).toBe(true);
    expect(String(rec.degradeReason)).toContain('未安装');
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([4096, 6144]);
  });

  it('宽高比偏差 >2% 时 cover 裁剪到精确尺寸并标注 cropped', async () => {
    const src = path.join(tmp, 'r4.png');
    const out = path.join(tmp, 'o4.png');
    await makeImg(src, 800, 1000);
    const rec = await upscaleToOriginal({ srcPath: src, outPath: out, origW: 1000, origH: 1000, engine: 'lanczos', timeoutSec: 60 });
    expect(rec.cropped).toBe(true);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1000]);
  });
});
