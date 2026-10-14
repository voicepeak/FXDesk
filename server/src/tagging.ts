import sharp from 'sharp';

const STOP_WORDS = [
  '参考图',
  '已删除素材',
  '在手中',
  '身体周围',
  '周围',
  '身后',
  '背景',
  '画面',
  '手中',
  '身上',
  '脸部',
  '头部',
  '面部',
  '添加',
  '加上',
  '加入',
  '叠加',
  '替换',
  '更换',
  '换成',
  '更换为',
  '替换为',
  '加',
  '的',
  '了',
  '在',
  '把',
  '将',
  '与',
  '和',
  '使',
  '让',
  '为',
  '是',
  '请',
  '要',
  '并',
  '且',
  '保持',
  '自然',
  '一致',
  '契合',
  '整个',
  '整体',
  '全部',
  '所有',
  '人物',
  '效果',
  '状态',
  '位置',
  '区域',
  '光影',
  '光线',
  '方向',
  '真实',
  '风格',
  '一张',
  '一个',
  '一些',
  '起来',
  '以及',
  '然后',
  '同时',
  '注意',
  '特效',
  '效果',
  '握持',
  '关系',
  '受光',
  '光照',
  '环境光',
  '光效',
  '轮廓光',
  '霓虹',
  '反光',
];

/** 轻量中文名词提取（自动打标用）：去掉动词/方位/停用词后保留候选词段 */
export function extractNouns(texts: string[]): string[] {
  const found: string[] = [];
  for (const raw of texts) {
    if (!raw) continue;
    let t = String(raw);
    t = t.replace(/参考图\s*\d+/g, ' ');
    t = t.replace(/[0-9０-９]+/g, ' ');
    t = t.replace(/[，。！？、；：,.!?;:()（）\[\]【】"'“”‘’…—-]/g, ' ');
    for (const w of STOP_WORDS) {
      t = t.split(w).join(' ');
    }
    t = t.replace(/\s+/g, ' ').trim();
    for (const seg of t.split(' ')) {
      const s = seg.trim();
      if (!s) continue;
      if (/^[a-zA-Z]+$/.test(s) && s.length < 2) continue;
      if (s.length > 12) {
        // 过长词段按 2 字滑窗？保守起见拆分为 2~4 字窗口取首段
        found.push(s.slice(0, 6));
      } else {
        found.push(s);
      }
    }
  }
  return [...new Set(found)];
}

export interface ColorInfo {
  hex: string;
  name: string;
  share: number;
}

const EXTENDED_COLORS: { name: string; hex: string }[] = [
  { name: '红', hex: '#E53935' },
  { name: '橙', hex: '#FB8C00' },
  { name: '黄', hex: '#FDD835' },
  { name: '绿', hex: '#43A047' },
  { name: '青', hex: '#00ACC1' },
  { name: '蓝', hex: '#1E88E5' },
  { name: '紫', hex: '#8E24AA' },
  { name: '粉', hex: '#EC407A' },
  { name: '棕', hex: '#795548' },
  { name: '黑', hex: '#101010' },
  { name: '白', hex: '#F5F5F5' },
  { name: '灰', hex: '#9E9E9E' },
];

export const KNOWN_COLOR_NAMES = EXTENDED_COLORS.map((c) => c.name);

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export function colorNameOf(hex: string): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const { h, s, l } = rgbToHsl(r, g, b);
  if (l < 0.12) return '黑';
  if (s < 0.12) {
    if (l > 0.85) return '白';
    if (l > 0.4) return '灰';
    return '黑';
  }
  if (h < 15 || h >= 345) return '红';
  if (h < 45) return l < 0.35 || s < 0.35 ? '棕' : '橙';
  if (h < 70) return '黄';
  if (h < 165) return '绿';
  if (h < 200) return '青';
  if (h < 255) return '蓝';
  if (h < 295) return '紫';
  return '粉';
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** k-means 3 色主色提取 */
export async function dominantColors(imgAbs: string, k = 3): Promise<ColorInfo[]> {
  const SIZE = 48;
  const raw = await sharp(imgAbs).resize(SIZE, SIZE, { fit: 'inside' }).removeAlpha().raw().toBuffer();
  const pixels: [number, number, number][] = [];
  const step = 3;
  for (let i = 0; i + 2 < raw.length; i += 3 * step) {
    pixels.push([raw[i], raw[i + 1], raw[i + 2]]);
  }
  if (!pixels.length) return [];
  const kk = Math.min(k, pixels.length);

  let centroids: [number, number, number][] = [];
  const seedIdx = [0, Math.floor(pixels.length / 2), pixels.length - 1];
  for (let i = 0; i < kk; i++) centroids.push([...pixels[seedIdx[i % seedIdx.length]]]);

  let assign = new Array<number>(pixels.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < pixels.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = (pixels[i][0] - centroids[c][0]) ** 2 + (pixels[i][1] - centroids[c][1]) ** 2 + (pixels[i][2] - centroids[c][2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    const sums: [number, number, number, number][] = Array.from({ length: kk }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pixels.length; i++) {
      const a = assign[i];
      sums[a][0] += pixels[i][0];
      sums[a][1] += pixels[i][1];
      sums[a][2] += pixels[i][2];
      sums[a][3]++;
    }
    for (let c = 0; c < kk; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
    if (!moved) break;
  }

  const counts = new Array<number>(kk).fill(0);
  for (const a of assign) counts[a]++;
  const total = pixels.length;

  return centroids
    .map((c, i) => ({
      hex: toHex(c[0], c[1], c[2]),
      name: colorNameOf(toHex(c[0], c[1], c[2])),
      share: counts[i] / total,
    }))
    .sort((a, b) => b.share - a.share);
}

export interface ImageStats {
  width: number;
  height: number;
  background: 'black' | 'transparent' | 'photo';
  colors: ColorInfo[];
}

export async function imageStats(imgAbs: string): Promise<ImageStats> {
  const meta = await sharp(imgAbs).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  let background: ImageStats['background'] = 'photo';
  try {
    const { data, info } = await sharp(imgAbs).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let alphaZero = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      const a = data[i * 4 + 3];
      if (a < 16) alphaZero++;
      sum += (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
      n++;
    }
    const alphaRatio = alphaZero / n;
    const avg = sum / n;
    if (alphaRatio > 0.5) background = 'transparent';
    else if (avg < 38) background = 'black';
  } catch {
    /* keep photo */
  }
  const colors = await dominantColors(imgAbs).catch(() => [] as ColorInfo[]);
  return { width: W, height: H, background, colors };
}

/** 归档标签：客单名 + 名词 + 主色 */
export function buildArchiveTags(opts: { jobName: string; character?: string; regionInstructions: string[]; globalInstruction: string; colors: ColorInfo[] }): string[] {
  const tags: string[] = [];
  const push = (t: string) => {
    const s = t.trim();
    if (s && !tags.includes(s)) tags.push(s);
  };
  if (opts.character) push(opts.character);
  for (const n of extractNouns(opts.regionInstructions)) push(n);
  for (const n of extractNouns([opts.globalInstruction])) push(n);
  const colorNames = [...new Set(opts.colors.slice(0, 2).map((c) => c.name))].map((n) => `${n}色`);
  for (const c of colorNames) push(c);
  push(opts.jobName);
  return tags;
}
