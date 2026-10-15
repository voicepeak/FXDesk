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
  tplAnalyze: `你是经验丰富的 Cosplay 角色识别助手。请观察所提供的 cos 场照（画面中有多名角色时，以占据画面主体位置的 coser 为准；可能附带补充参考图）。
【输出要求】仅输出一个 JSON 对象，不要输出任何解释或 Markdown 代码块：
{"character":"角色名","work":"出自的作品名","aliases":["常见别称或英文名"],"scene":"当前场照的场景、服装与道具一句话描述","confidence":0.0,"notes":"不确定时的说明，确定时留空"}
confidence 为 0~1 的小数。无法确定角色名时 character 留空字符串，并在 notes 说明原因。`,
  tplPropose: `你是资深后期特效合成师，正在为一张 cos 场照设计特效方案。请综合识别信息、客户要求与参考图，为每个建议特效同时给出两条描述：
【生成描述 genPrompt】用于生成一张与场图同构图、同角度的特效预演草图（1K）：说明特效类型与形态、出现位置与角度、大小、颜色、发光方式、受光方向，以及与人物/环境的关系。
【融入描述 blendPrompt】用于最终把该特效合成进场图：说明特效挂在画面何处、遮挡与前后层级（人物与特效谁在谁之前）、与地面或环境的衔接、亮度与色温匹配要求；称呼本特效时直接说「本特效」，不要写参考图编号。
【识别信息】{{analysis}}
【客户要求】{{brief}}
【工作室要求】{{houseRules}}
【可用附图】第一张附图为场图本身（图1），其后为参考资料，编号从图2开始：{{refs}}
【输出要求】仅输出一个 JSON 对象，不要输出解释或 Markdown 代码块：
{"summary":"一句话方案概述","effects":[{"title":"特效名（如：雷电剑气）","kind":"light|prop|background|other","genPrompt":"……","blendPrompt":"……","refs":[2]}]}
effects 数量 1~3 条；refs 填写该特效需要引用的附图编号数组（没有则空数组）。不得改变人物身份、五官、动作与整体构图。`,
  tplEffectSystem: `你是特效预演师。请基于第一张场图，生成一张与场图同构图、同角度、同人物姿态的特效预演草图（后续附图是参考素材，只参考其中的物品/特效外观，不要照搬其构图或背景）。
只在要求的位置添加特效，其余画面保持不变；特效的光照方向、色温要与场图现有光照一致。输出图中不要出现任何文字、水印或边框。`,
  tplBlend: `【参考图{{refNo}}·融入要求】{{blendPrompt}}`,
};

export interface AppSettings {
  apiKey: string; // stored as obf:<base64>
  baseUrl: string;
  /** 服务商协议：auto 按 Base URL 自动识别（含 grsai/dakka → GrsAI，否则墨墨） */
  provider: 'auto' | 'momo' | 'grsai';
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
  /** 锁脸（复制原图面部图层，最后一步，强制复检硬门槛） */
  qcFaceLock: boolean;
  /** 锁脸后身份相似度硬门槛（≥ 视为通过） */
  qcFaceLockPass: number;
  tplSystem: string;
  tplRegion: string;
  tplGlobal: string;
  tplEnding: string;
  tplFaceRepair: string;
  tplRepair: string;
  tplPlate: string;
  tplAnalyze: string;
  tplPropose: string;
  tplEffectSystem: string;
  tplBlend: string;
  /** AI 筹备：识别分析服务商协议（doubao-web=豆包网页版浏览器自动化，需扫码登录） */
  analysisProtocol: 'auto' | 'openai' | 'gemini' | 'doubao-web';
  /** AI 筹备：关闭思考模式（豆包 Seed 系思考模型大幅提速；中转站不支持时自动去掉该参数重试） */
  analysisDisableThinking: boolean;
  analysisBaseUrl: string;
  analysisApiKey: string; // stored as obf:<base64>
  analysisModelId: string;
  /** AI 筹备：特效预演服务商（可独立于上方连接配置；留空字段沿用上方） */
  effectProtocol: 'auto' | 'momo' | 'grsai';
  effectBaseUrl: string;
  effectApiKey: string; // stored as obf:<base64>
  effectModelId: string;
  /** AI 筹备：工作室自己的要求（注入特效见解） */
  prepHouseRules: string;
  /** AI 筹备：识别/见解单次调用等待上限（秒） */
  analysisTimeoutSec: number;
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
    provider: 'auto',
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
    qcFaceLock: true,
    qcFaceLockPass: 0.95,
    ...DEFAULT_TEMPLATES,
    analysisProtocol: 'auto',
    analysisDisableThinking: true,
    analysisBaseUrl: '',
    analysisApiKey: '',
    analysisModelId: 'doubao-seed-1.6',
    effectProtocol: 'auto',
    effectBaseUrl: '',
    effectApiKey: '',
    effectModelId: 'gpt-image-2.5-sunburst',
    prepHouseRules: '',
    analysisTimeoutSec: 180,
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
  tplPropose: ['{{analysis}}', '{{brief}}', '{{houseRules}}', '{{refs}}'],
  tplBlend: ['{{refNo}}', '{{blendPrompt}}'],
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
  return {
    ...s,
    apiKey: hasApiKey(s) ? 'obf:***' : '',
    analysisApiKey: s.analysisApiKey ? 'obf:***' : '',
    effectApiKey: s.effectApiKey ? 'obf:***' : '',
  };
}

/** 分析（AI 筹备·识别/见解）实际使用的连接配置：独立服务商留空则沿用全局 */
export function resolveAnalysisSettings(s: AppSettings): AppSettings {
  return {
    ...s,
    baseUrl: s.analysisBaseUrl.trim() || s.baseUrl,
    apiKey: s.analysisApiKey || s.apiKey,
  };
}

/** 特效预演实际使用的连接配置：独立服务商留空则沿用全局 */
export function resolveEffectSettings(s: AppSettings): AppSettings {
  const hasOwn = !!s.effectBaseUrl.trim();
  return {
    ...s,
    baseUrl: s.effectBaseUrl.trim() || s.baseUrl,
    provider: s.effectProtocol !== 'auto' ? s.effectProtocol : hasOwn ? 'auto' : s.provider,
    apiKey: s.effectApiKey || s.apiKey,
    modelId: s.effectModelId.trim() || s.modelId,
  };
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
  if (typeof patch.analysisApiKey === 'string' && patch.analysisApiKey !== 'obf:***') {
    next.analysisApiKey = patch.analysisApiKey === '' ? '' : encodeKey(patch.analysisApiKey);
  }
  if (typeof patch.effectApiKey === 'string' && patch.effectApiKey !== 'obf:***') {
    next.effectApiKey = patch.effectApiKey === '' ? '' : encodeKey(patch.effectApiKey);
  }
  if (patch.analysisProtocol !== undefined) {
    next.analysisProtocol = ['auto', 'openai', 'gemini', 'doubao-web'].includes(String(patch.analysisProtocol))
      ? (patch.analysisProtocol as AppSettings['analysisProtocol'])
      : 'auto';
  }
  if (patch.effectProtocol !== undefined) {
    next.effectProtocol = ['auto', 'momo', 'grsai'].includes(String(patch.effectProtocol))
      ? (patch.effectProtocol as AppSettings['effectProtocol'])
      : 'auto';
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
  if (patch.qcFaceLockPass !== undefined) {
    const v = Number(patch.qcFaceLockPass);
    next.qcFaceLockPass = Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : 0.95;
  }
  if (patch.qcIdentityPass !== undefined) {
    const v = Number(patch.qcIdentityPass);
    next.qcIdentityPass = Number.isFinite(v) ? Math.min(1, Math.max(0.1, v)) : 0.62;
  }
  if (patch.qcIdentityMid !== undefined) {
    const v = Number(patch.qcIdentityMid);
    next.qcIdentityMid = Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.5;
  }
  if (patch.analysisTimeoutSec !== undefined) {
    const seconds = Number(patch.analysisTimeoutSec);
    next.analysisTimeoutSec = Number.isFinite(seconds) ? Math.min(900, Math.max(30, Math.round(seconds))) : 180;
  }

  saveSettings(next);
  return { ok: true, settings: next };
}

export function isMockMode(s?: AppSettings): boolean {
  if (process.env.FXDESK_MOCK === '1') return true;
  const st = s ?? loadSettings();
  return !!st.mockApi;
}
