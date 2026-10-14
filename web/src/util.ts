import type { Bbox, JobStatus } from './types';

export const PALETTE = ['#E53935', '#FDD835', '#1E88E5', '#43A047', '#8E24AA'];
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

export function normalizeHex(hex: string): string {
  let h = (hex || '').trim().toUpperCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9A-F]{3}$/.test(h)) h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  return h;
}

export function colorName(hex: string): string {
  return PALETTE_NAMES[normalizeHex(hex)] ?? '红';
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface MarkerSpec {
  stroke: number;
  badge: number;
  fontSize: number;
}

export function computeMarkerSpec(W: number, H: number): MarkerSpec {
  const long = Math.max(W, H);
  const short = Math.min(W, H);
  const stroke = Math.max(4, Math.round(long * 0.004));
  const badge = Math.max(40, Math.round(short * 0.035));
  return { stroke, badge, fontSize: Math.round(badge * 0.55) };
}

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

export function normBbox(b: Bbox): Bbox {
  return {
    x1: Math.min(b.x1, b.x2),
    y1: Math.min(b.y1, b.y2),
    x2: Math.max(b.x1, b.x2),
    y2: Math.max(b.y1, b.y2),
  };
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}分${rs}秒`;
}

export function fmtCost(v: number | null | undefined): string {
  return `¥${(v ?? 0).toFixed(2)}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  draft: '编辑中',
  queued: '排队中',
  generating: '生成中',
  qc: '质检中',
  review: '待审核',
  repairing: '重修中',
  failed: '失败',
  delivered: '已交付',
  canceled: '已取消',
};

export const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  uploading: '上传中',
  generating: '生成中',
  retrying: '限流重试中',
  downloading: '下载中',
  upscaling: '超分中',
  qc: '质检中',
  review: '待审核',
  failed: '失败',
  canceled: '已取消',
  repairing: '重修中',
  delivered: '已交付',
};

export const JOB_GROUPS = [
  { key: 'ongoing', title: '进行中' },
  { key: 'review', title: '待审核' },
  { key: 'delivered', title: '已完成' },
] as const;

export function statusGroup(status: JobStatus): typeof JOB_GROUPS[number]['key'] {
  if (status === 'review') return 'review';
  if (status === 'delivered') return 'delivered';
  return 'ongoing';
}

export function taskStatusLabel(status: JobStatus): string {
  if (status === 'failed' || status === 'canceled') return STATUS_LABELS[status];
  return JOB_GROUPS.find((group) => group.key === statusGroup(status))!.title;
}

export function taskStatusClass(status: JobStatus): string {
  return `st-${status === 'failed' || status === 'canceled' ? status : statusGroup(status)}`;
}

export function cls(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
