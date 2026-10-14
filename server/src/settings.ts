import fs from 'node:fs';
import { ws, ensureWorkspaceDirs } from './env';
import { getDb } from './db';
import { logLine } from './logger';

export const DEFAULT_TEMPLATES = {
  tplSystem: `你是顶级商业修图与特效合成师。请对提供的图片进行精确修改，并严格遵守以下锁定要求：
【身份锁定】不得改变人物的身份识别特征（五官结构、妆容特征、发型轮廓）。
【构图锁定】不得改变画面构图、人物位置、人物动作姿态、比例与透视关系。
【光影锁定】所有新增元素的受光方向、色温、阴影投射必须与画面现有光照逻辑一致。
【材质保真】人物服装、道具、发型的材质与花纹细节保持原有特征不变。
除明确要求修改的区域外，画面其他部分不得发生变化。`,
  tplRegion: `【{{color}}框 第{{n}}区】位置：{{location}}。要求：{{instruction}}`,
  tplGlobal: `【全局修改】{{globalInstruction}}`,
  tplEnding: `【融合要求】所有新增元素需与画面在光影、透视、景深、颗粒感上自然融合；新增元素与人物发生遮挡关系时，遮挡边缘自然。
【输出要求】输出与输入同构图的成品图；移除画面上所有彩色框标记、编号、辅助线与文字，不得将标记残留于成品。`,
  tplFaceRepair: `以参考图1中的人物面部为准，修正本图面部为参考图1的同一人物（五官结构、妆容、肤色一致），保持本图现有的光线方向、角度、表情与质感，不改变发型与画面其他内容。`,
  tplRepair: `【{{color}}框 第{{n}}区】位置：{{location}}。修复要求：{{repairInstruction}}`,
  tplPlate: `移除画面中的全部人物、场景与环境，仅保留【{{effectDescription}}】特效本身，输出为纯黑背景图，特效以原有颜色、形态、透明度呈现，不添加任何其他内容。`,
};

export interface AppSettings {
  apiKey: string; // stored as obf:<base64>
  baseUrl: string;
  modelId: string;
  imageSize: '1K' | '2K' | '4K';
  aspectRatio: string; // '' = 自动使用主图最接近的支持比例
  pricePerImage: number;
  queueConcurrency: number;
  runTimeoutSec: number;
  notifySound: boolean;
  notifyToast: boolean;
  qcIdentityPass: number;
  qcIdentityMid: number;
  qcAutoFaceRepair: boolean;
  tplSystem: string;
  tplRegion: string;
  tplGlobal: string;
  tplEnding: string;
  tplFaceRepair: string;
  tplRepair: string;
  tplPlate: string;
  sendMaxDimension: number;
  upscaleEngine: 'realesrgan' | 'lanczos';
  upscaleTimeoutSec: number;
  workspacePath: string;
  mockApi: boolean;
  materialSoftLimit: number;
}

export function defaultSettings(): AppSettings {
  return {
    apiKey: '',
    baseUrl: 'https://api.momoapi.icu',
    modelId: '[Mo]nano-banana-pro',
    imageSize: '4K',
    aspectRatio: '',
    pricePerImage: 0.3,
    queueConcurrency: 2,
    runTimeoutSec: 600,
    notifySound: true,
    notifyToast: true,
    qcIdentityPass: 0.62,
    qcIdentityMid: 0.5,
    qcAutoFaceRepair: true,
    ...DEFAULT_TEMPLATES,
    sendMaxDimension: 4096,
    upscaleEngine: 'realesrgan',
    upscaleTimeoutSec: 900,
    workspacePath: './workspace',
    mockApi: false,
    materialSoftLimit: 4,
  };
}

const REQUIRED_PLACEHOLDERS: Partial<Record<keyof AppSettings, string[]>> = {
  tplRegion: ['{{color}}', '{{n}}', '{{location}}', '{{instruction}}'],
  tplGlobal: ['{{globalInstruction}}'],
  tplRepair: ['{{color}}', '{{n}}', '{{location}}', '{{repairInstruction}}'],
  tplPlate: ['{{effectDescription}}'],
};

let cached: AppSettings | null = null;
let cachedStamp = 0;

function configPath(): string {
  return ws('config.json');
}

function configStamp(): number {
  try {
    return fs.statSync(configPath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadSettings(force = false): AppSettings {
  if (cached && !force && configStamp() === cachedStamp) return cached;
  ensureWorkspaceDirs();
  let s = defaultSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<AppSettings>;
    s = { ...s, ...raw };
  } catch {
    // first run
  }
  cached = s;
  cachedStamp = configStamp();
  return s;
}

export function saveSettings(next: AppSettings): void {
  cached = next;
  ensureWorkspaceDirs();
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cachedStamp = configStamp();
  try {
    const db = getDb();
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(next)) upsert.run(k, JSON.stringify(v));
  } catch (e) {
    logLine('warn', 'settings mirror to db failed', String(e));
  }
}

export function hasApiKey(s: AppSettings): boolean {
  return s.apiKey.startsWith('obf:') && s.apiKey.length > 4;
}

export function encodeKey(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('obf:')) return raw;
  return 'obf:' + Buffer.from(raw, 'utf8').toString('base64');
}

export function decodeKey(stored: string): string {
  if (!stored) return '';
  if (stored.startsWith('obf:')) {
    try {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return stored;
}

export function publicSettings(s: AppSettings): Record<string, unknown> {
  return { ...s, apiKey: hasApiKey(s) ? 'obf:***' : '' };
}

export interface SettingsUpdateResult {
  ok: boolean;
  error?: string;
  settings?: AppSettings;
}

export function updateSettings(patch: Partial<AppSettings>): SettingsUpdateResult {
  const cur = loadSettings();
  const next: AppSettings = { ...cur };

  for (const [k, v] of Object.entries(patch)) {
    if (!(k in next)) continue;
    (next as unknown as Record<string, unknown>)[k] = v;
  }

  for (const [key, required] of Object.entries(REQUIRED_PLACEHOLDERS)) {
    const tpl = String((next as unknown as Record<string, unknown>)[key] ?? '');
    for (const ph of required!) {
      if (!tpl.includes(ph)) {
        return { ok: false, error: `模板 ${key} 缺少必需占位符 ${ph}（占位符不可删改）` };
      }
    }
  }

  if (typeof patch.apiKey === 'string' && patch.apiKey !== 'obf:***') {
    next.apiKey = patch.apiKey === '' ? '' : encodeKey(patch.apiKey);
  }

  if (patch.queueConcurrency !== undefined) {
    next.queueConcurrency = Math.min(4, Math.max(1, Math.round(Number(patch.queueConcurrency) || 2)));
  }
  if (patch.sendMaxDimension !== undefined) {
    next.sendMaxDimension = Math.max(512, Math.round(Number(patch.sendMaxDimension) || 4096));
  }
  if (patch.upscaleEngine !== undefined) {
    next.upscaleEngine = patch.upscaleEngine === 'lanczos' ? 'lanczos' : 'realesrgan';
  }
  if (patch.upscaleTimeoutSec !== undefined) {
    const seconds = Number(patch.upscaleTimeoutSec);
    next.upscaleTimeoutSec = Number.isFinite(seconds) ? Math.min(3600, Math.max(60, Math.round(seconds))) : 900;
  }
  if (patch.runTimeoutSec !== undefined) {
    const seconds = Number(patch.runTimeoutSec);
    if (!Number.isFinite(seconds) || seconds < 60 || seconds > 1800) {
      return { ok: false, error: '生成等待上限需在 60～1800 秒之间' };
    }
    next.runTimeoutSec = Math.round(seconds);
  }

  saveSettings(next);
  return { ok: true, settings: next };
}

export function isMockMode(s?: AppSettings): boolean {
  if (process.env.FXDESK_MOCK === '1') return true;
  const st = s ?? loadSettings();
  return !!st.mockApi;
}
