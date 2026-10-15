import type { Bbox, MaterialRow, RefToken, RegionRow } from './types';

export const PALETTE = ['#E53935', '#FDD835', '#1E88E5', '#43A047', '#8E24AA'] as const;

export const PALETTE_NAMES: Record<string, string> = {
  '#E53935': '红',
  '#FDD835': '黄',
  '#1E88E5': '蓝',
  '#43A047': '绿',
  '#8E24AA': '紫',
};

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export function colorName(hex: string): string {
  const up = normalizeHex(hex);
  if (PALETTE_NAMES[up]) return PALETTE_NAMES[up];
  let best = '红';
  let bestD = Infinity;
  for (const [h, n] of Object.entries(PALETTE_NAMES)) {
    const d = hexDistance(up, h);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

export function normalizeHex(hex: string): string {
  let h = (hex || '').trim().toUpperCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9A-F]{3}$/.test(h)) {
    h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  }
  return h;
}

function hexDistance(a: string, b: string): number {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  return (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** 附录 B.3 方位描述：九宫格 + 面积档位 */
export function locationOf(bbox: Bbox, W: number, H: number): string {
  const cx = (bbox.x1 + bbox.x2) / 2 / W;
  const cy = (bbox.y1 + bbox.y2) / 2 / H;
  const horiz = cx < 0.33 ? 'left' : cx < 0.66 ? 'mid' : 'right';
  const vert = cy < 0.33 ? 'top' : cy < 0.66 ? 'mid' : 'bottom';

  const table: Record<string, string> = {
    'top-left': '画面左上部',
    'top-mid': '画面中上部',
    'top-right': '画面右上部',
    'mid-left': '画面左侧中部',
    'mid-mid': '画面中央',
    'mid-right': '画面右侧中部',
    'bottom-left': '画面左下部',
    'bottom-mid': '画面中下部',
    'bottom-right': '画面右下部',
  };
  const pos = table[`${vert}-${horiz}`];

  const area = Math.max(0, bbox.x2 - bbox.x1) * Math.max(0, bbox.y2 - bbox.y1) / (W * H);
  const areaText = area < 0.08 ? '覆盖范围较小' : area < 0.35 ? '覆盖范围适中' : '覆盖范围较大';
  return `${pos}，${areaText}`;
}

export function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export interface AssembleRegionInput {
  idx: number;
  color: string;
  bbox: Bbox;
  instruction: string;
  /** 引用素材的融入说明（来自库素材 blend_prompt），随区域一起注入 */
  blendNotes?: { refNo: number; blendPrompt: string }[];
}

export interface AssembleTemplates {
  tplSystem: string;
  tplRegion: string;
  tplGlobal: string;
  tplEnding: string;
  /** 融入说明模板（把参考图N的素材如何溶入画面写清，防歧义），留空则不注入 */
  tplBlend?: string;
}

export interface AssembledBlock {
  kind: 'system' | 'region' | 'global' | 'ending';
  label: string;
  text: string;
  regionId?: string;
  color?: string;
}

export interface AssembledPrompt {
  finalPrompt: string;
  blocks: AssembledBlock[];
}

/** 区域块文本 = 区域模板 + 各引用素材的融入说明（如有） */
export function regionBlockText(region: AssembleRegionInput, templates: AssembleTemplates, W: number, H: number): string {
  const base = applyTemplate(templates.tplRegion, {
    color: colorName(region.color),
    n: String(region.idx),
    location: locationOf(region.bbox, W, H),
    instruction: region.instruction,
  });
  if (!templates.tplBlend) return base;
  const lines = (region.blendNotes ?? [])
    .filter((n) => n.blendPrompt.trim())
    .map((n) => applyTemplate(templates.tplBlend!, { refNo: String(n.refNo), blendPrompt: n.blendPrompt.trim() }));
  return lines.length ? [base, ...lines].join('\n') : base;
}

/** §4.4.4 拼装算法 */
export function assemblePrompt(input: {
  regions: AssembleRegionInput[];
  globalInstruction: string;
  templates: AssembleTemplates;
  W: number;
  H: number;
}): AssembledPrompt {
  const { regions, globalInstruction, templates, W, H } = input;
  const blocks: AssembledBlock[] = [];

  blocks.push({ kind: 'system', label: '系统块（锁定区）', text: templates.tplSystem });

  const sorted = [...regions].sort((a, b) => a.idx - b.idx);
  for (const r of sorted) {
    const text = regionBlockText(r, templates, W, H);
    blocks.push({ kind: 'region', label: `区域块 ${r.idx}`, text, regionId: undefined, color: normalizeHex(r.color) });
  }

  if (globalInstruction && globalInstruction.trim()) {
    blocks.push({
      kind: 'global',
      label: '全局块',
      text: applyTemplate(templates.tplGlobal, { globalInstruction: globalInstruction.trim() }),
    });
  }

  blocks.push({ kind: 'ending', label: '收尾块', text: templates.tplEnding });

  return { finalPrompt: blocks.map((b) => b.text).join('\n'), blocks };
}

/** 单个区域行的预览文本（供前端总览展示） */
export function regionLine(region: AssembleRegionInput, templates: AssembleTemplates, W: number, H: number): string {
  return regionBlockText(region, templates, W, H);
}

export function parseBbox(json: string): Bbox {
  try {
    const b = JSON.parse(json) as Bbox;
    return {
      x1: +b.x1 || 0, y1: +b.y1 || 0, x2: +b.x2 || 0, y2: +b.y2 || 0,
      ...(['rect', 'ellipse', 'polygon', 'lasso'].includes(b.shape ?? '') ? { shape: b.shape } : {}),
      ...(Array.isArray(b.points) ? { points: b.points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })) } : {}),
    };
  } catch {
    return { x1: 0, y1: 0, x2: 0, y2: 0 };
  }
}

export function parseTokens(json: string | null): RefToken[] {
  try {
    const t = JSON.parse(json ?? '[]');
    return Array.isArray(t) ? (t as RefToken[]) : [];
  } catch {
    return [];
  }
}

/**
 * 素材删除/重排后的参考图重编号（§4.4.3）：
 * - 区域 token 与新的附件顺序保持一致
 * - 指令文本中的“参考图N”同步改写；被删除素材的引用改写为“已删除素材”
 */
export function renumberRegions(
  regions: Pick<RegionRow, 'id' | 'instruction' | 'ref_tokens'>[],
  oldMaterials: Pick<MaterialRow, 'id' | 'order_index'>[],
  newMaterials: Pick<MaterialRow, 'id' | 'order_index'>[],
  deletedMaterialIds: string[]
): { id: string; instruction: string; ref_tokens: string }[] {
  const oldNoById = new Map<string, number>();
  for (const m of oldMaterials) oldNoById.set(m.id, m.order_index);
  const newNoById = new Map<string, number>();
  for (const m of newMaterials) newNoById.set(m.id, m.order_index);

  const oldNoToNew = new Map<number, number>();
  for (const m of newMaterials) {
    const oldNo = oldNoById.get(m.id);
    if (oldNo !== undefined) oldNoToNew.set(oldNo, m.order_index);
  }
  const deletedOldNos = new Set<number>();
  for (const id of deletedMaterialIds) {
    const oldNo = oldNoById.get(id);
    if (oldNo !== undefined) deletedOldNos.add(oldNo);
  }

  const fixText = (text: string): string => {
    return text.replace(/参考图(\d+)/g, (m, ds: string) => {
      const n = parseInt(ds, 10);
      if (deletedOldNos.has(n)) return '已删除素材';
      if (oldNoToNew.has(n)) return `参考图${oldNoToNew.get(n)}`;
      return m;
    });
  };

  return regions.map((r) => {
    const tokens = parseTokens(r.ref_tokens)
      .filter((t) => !deletedMaterialIds.includes(t.materialId))
      .map((t) => ({
        materialId: t.materialId,
        refNo: newNoById.get(t.materialId) ?? t.refNo,
        name: t.name,
      }))
      .filter((t) => newNoById.has(t.materialId));
    return {
      id: r.id,
      instruction: fixText(r.instruction),
      ref_tokens: JSON.stringify(tokens),
    };
  });
}
