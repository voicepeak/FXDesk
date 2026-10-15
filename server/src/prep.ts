import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { abs } from './env';
import { isMockMode, loadSettings, resolveAnalysisSettings, type AppSettings } from './settings';
import { logEvent } from './logger';
import { applyTemplate } from './prompt';
import { imageStats, extractNouns } from './tagging';
import { emitJobUpdate, emitLibUpdate, emitPrepUpdate } from './sse';
import { extractJsonObject, visionChat, VisionError, type VisionImage } from './vision';
import { doubaoWebChat, mergeWebPrompt, DoubaoError } from './doubao';
import type { AnalysisResult, EffectKind, JobEffectRow, JobPrepRow, JobRow, MaterialRow, MaterialRole } from './types';

export const MATERIAL_ROLE_LABELS: Record<MaterialRole, string> = {
  general: '综合参考',
  analysis: '角色补充参考',
  style: '特效风格参照',
  item: '物品参照',
  effect: '特效素材',
};

export function materialRoleLabel(role: string): string {
  return MATERIAL_ROLE_LABELS[(role as MaterialRole) ?? 'general'] ?? MATERIAL_ROLE_LABELS.general;
}

export function isMaterialRole(v: unknown): v is MaterialRole {
  return v === 'general' || v === 'analysis' || v === 'style' || v === 'item' || v === 'effect';
}

/** 视觉分析调度：豆包网页版（浏览器自动化）或 HTTP 中转（OpenAI/Gemini 兼容） */
async function runVision(opts: {
  images: VisionImage[];
  systemPrompt: string;
  userPrompt: string;
  settings: AppSettings;
  context: string;
  onStage?: (stage: string) => void;
}): Promise<{ text: string }> {
  if (opts.settings.analysisProtocol === 'doubao-web') {
    return doubaoWebChat({
      images: opts.images,
      prompt: mergeWebPrompt(opts.systemPrompt, opts.userPrompt),
      timeoutSec: opts.settings.analysisTimeoutSec,
      context: opts.context,
      onStage: opts.onStage,
    });
  }
  const res = await visionChat({
    images: opts.images,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    settings: opts.settings,
    context: opts.context,
  });
  return { text: res.text };
}

/* ---------------- prep 行管理 ---------------- */

export function ensurePrepRow(jobId: string): JobPrepRow {
  const db = getDb();
  let row = db.prepare('SELECT * FROM job_preps WHERE job_id=?').get(jobId) as JobPrepRow | undefined;
  if (!row) {
    const now = Date.now();
    db.prepare('INSERT INTO job_preps (id, job_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(randomUUID(), jobId, now, now);
    row = db.prepare('SELECT * FROM job_preps WHERE job_id=?').get(jobId) as JobPrepRow;
  }
  return row;
}

/** 启动恢复：中断的识别/见解任务与特效条目标记为失败（可重试） */
export function recoverPrepInterrupted(): number {
  const db = getDb();
  const now = Date.now();
  const r1 = db
    .prepare("UPDATE job_preps SET analysis_status='failed', analysis_error='interrupted', updated_at=? WHERE analysis_status='running'")
    .run(now);
  const r2 = db
    .prepare("UPDATE job_preps SET proposal_status='failed', proposal_error='interrupted', updated_at=? WHERE proposal_status='running'")
    .run(now);
  const r3 = db
    .prepare("UPDATE job_effects SET status='failed', error='interrupted', updated_at=? WHERE status IN ('queued','generating')")
    .run(now);
  return r1.changes + r2.changes + r3.changes;
}

/* ---------------- 识别分析 ---------------- */

export function normalizeAnalysis(raw: unknown): AnalysisResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const aliases = Array.isArray(o.aliases)
    ? (o.aliases as unknown[]).map((a) => asStr(a, 60)).filter(Boolean).slice(0, 6)
    : [];
  const conf = Number(o.confidence);
  return {
    character: asStr(o.character, 80),
    work: asStr(o.work, 120),
    aliases,
    scene: asStr(o.scene, 400),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    notes: asStr(o.notes, 300),
  };
}

export function buildAnalysisUserPrompt(characterHint: string, refCount = 0): string {
  const hint = characterHint.trim();
  const base = hint
    ? `请按输出要求识别第一张 cos 场照。委托方提供的角色线索：${hint}（仅供参考，请以画面为准）。`
    : '请按输出要求识别第一张 cos 场照。';
  const refs = refCount > 0 ? `另附 ${refCount} 张参考图（角色其他角度/服装/道具），一并作为识别参考。` : '';
  return base + refs;
}

/** 逐张读取图片并缩到发送长边内（保持体积可控） */
async function visionPartFromFile(fileAbs: string, maxDim: number): Promise<VisionImage | null> {
  try {
    const meta = await sharp(fileAbs).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const long = Math.max(W, H);
    let img = sharp(fileAbs);
    if (long > maxDim) {
      const scale = maxDim / long;
      img = img.resize(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
    }
    const usePng = meta.format === 'png' && meta.hasAlpha === true;
    const buf = usePng ? await img.png().toBuffer() : await img.jpeg({ quality: 88 }).toBuffer();
    return { mime: usePng ? 'image/png' : 'image/jpeg', base64: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function collectAnalysisImages(job: JobRow): Promise<VisionImage[]> {
  const settings = loadSettings();
  const db = getDb();
  const maxDim = Math.min(settings.sendMaxDimension, 4096);
  const images: VisionImage[] = [];
  const orig = await visionPartFromFile(abs(job.original_path), maxDim);
  if (orig) images.push(orig);
  // 参考图一并带上（排除特效素材；最多 4 张，控制体积与噪音）
  const extras = db
    .prepare("SELECT * FROM job_materials WHERE job_id=? AND role != 'effect' ORDER BY order_index LIMIT 4")
    .all(job.id) as MaterialRow[];
  for (const m of extras) {
    const fileAbs = materialFileAbs(m);
    if (!fileAbs) continue;
    const part = await visionPartFromFile(fileAbs, Math.min(maxDim, 2048));
    if (part) images.push(part);
  }
  return images;
}

function mockAnalysis(): AnalysisResult {
  return {
    character: '示例角色',
    work: '示例作品（模拟模式）',
    aliases: ['Sample'],
    scene: '室内场馆 cos 场照，角色持道具站立（模拟结果）。',
    confidence: 0.9,
    notes: '',
  };
}

/** 启动识别分析（异步执行，状态写入 job_preps，进度经 SSE prep_update 推送） */
export function startAnalysis(jobId: string): { status: 'running' | 'already_running' } {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
  if (!job) throw Object.assign(new Error('客单不存在'), { statusCode: 404, code: 'JOB_NOT_FOUND' });
  const prep = ensurePrepRow(jobId);
  if (prep.analysis_status === 'running') return { status: 'already_running' };

  const settings = loadSettings();
  const analysisSettings = resolveAnalysisSettings(settings);
  const isWeb = settings.analysisProtocol === 'doubao-web';
  if (!isMockMode(settings) && !isWeb && !analysisSettings.apiKey) throw Object.assign(new Error('未配置分析服务 API Key（设置页「AI 筹备」，留空则沿用上方连接配置）'), { statusCode: 400, code: 'NO_API_KEY' });
  if (!isMockMode(settings) && !isWeb && !settings.analysisModelId.trim()) throw Object.assign(new Error('未配置分析模型 ID（设置页「AI 筹备」）'), { statusCode: 400, code: 'NO_ANALYSIS_MODEL' });

  const now = Date.now();
  db.prepare("UPDATE job_preps SET analysis_status='running', analysis_error=NULL, analysis_started_at=?, updated_at=? WHERE job_id=?").run(now, now, jobId);
  emitPrepUpdate({ jobId, kind: 'analysis', status: 'running', stage: '正在准备…' });

  void (async () => {
    let rawText = '';
    try {
      let parsed: unknown;
      if (isMockMode(settings)) {
        await new Promise((r) => setTimeout(r, 800));
        parsed = mockAnalysis();
      } else {
        const images = await collectAnalysisImages(job);
        const res = await runVision({
          images,
          systemPrompt: settings.tplAnalyze,
          userPrompt: buildAnalysisUserPrompt(job.character, Math.max(0, images.length - 1)),
          settings: analysisSettings,
          context: `analysis:${jobId}`,
          onStage: (stage) => emitPrepUpdate({ jobId, kind: 'analysis', status: 'running', stage }),
        });
        rawText = res.text;
        parsed = extractJsonObject(res.text);
      }
      const result = normalizeAnalysis(parsed);
      const db2 = getDb();
      db2.prepare(
        "UPDATE job_preps SET analysis_status='done', analysis_result=?, analysis_raw=?, analysis_error=NULL, analysis_finished_at=?, analysis_confirmed_at=NULL, updated_at=? WHERE job_id=?"
      ).run(JSON.stringify(result), rawText || null, Date.now(), Date.now(), jobId);
      const fresh = db2.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
      if (fresh && !fresh.character.trim() && result.character) {
        db2.prepare('UPDATE jobs SET character=?, updated_at=? WHERE id=?').run(result.character, Date.now(), jobId);
      }
      logEvent('info', `识别分析完成：${result.character || '（未识别）'}${result.work ? ` · ${result.work}` : ''}`, { jobId });
      emitPrepUpdate({ jobId, kind: 'analysis', status: 'done' });
      emitJobUpdate(jobId);
    } catch (e) {
      const msg = e instanceof VisionError || e instanceof DoubaoError ? e.message : e instanceof Error ? e.message : String(e);
      getDb()
        .prepare("UPDATE job_preps SET analysis_status='failed', analysis_error=?, analysis_raw=?, analysis_finished_at=?, updated_at=? WHERE job_id=?")
        .run(msg, rawText || null, Date.now(), Date.now(), jobId);
      logEvent('warn', `识别分析失败：${msg}`, { jobId });
      emitPrepUpdate({ jobId, kind: 'analysis', status: 'failed', error: msg });
    }
  })();

  return { status: 'running' };
}

/* ---------------- 特效见解 ---------------- */

export interface ProposalEffect {
  title: string;
  kind: EffectKind;
  genPrompt: string;
  blendPrompt: string;
  refs: number[];
}

export interface ProposalData {
  summary: string;
  effects: ProposalEffect[];
}

const KINDS: EffectKind[] = ['light', 'prop', 'background', 'other'];

/** 附件编号约定：图1 = 场图本身，图2 起顺次对应 materials（与发送顺序一致） */
export function normalizeProposal(raw: unknown, materialCount: number): ProposalData {
  const o = (raw ?? {}) as Record<string, unknown>;
  const summary = String(o.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const list = Array.isArray(o.effects) ? (o.effects as unknown[]) : [];
  const effects: ProposalEffect[] = [];
  for (const item of list) {
    if (effects.length >= 3) break;
    const e = (item ?? {}) as Record<string, unknown>;
    const title = String(e.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const genPrompt = String(e.genPrompt ?? '').trim().slice(0, 2000);
    if (!title && !genPrompt) continue;
    const kindRaw = String(e.kind ?? 'other').trim().toLowerCase() as EffectKind;
    const refs = Array.isArray(e.refs)
      ? [...new Set((e.refs as unknown[]).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 2 && n <= materialCount + 1))]
      : [];
    effects.push({
      title: title || genPrompt.slice(0, 20),
      kind: KINDS.includes(kindRaw) ? kindRaw : 'other',
      genPrompt,
      blendPrompt: String(e.blendPrompt ?? '').trim().slice(0, 1000),
      refs,
    });
  }
  return { summary, effects };
}

export function buildRefsList(materials: MaterialRow[]): string {
  if (!materials.length) return '（无参考资料，仅场图一张）';
  return materials.map((m, i) => `图${i + 2}（${materialRoleLabel(m.role)}）：${m.display_name}`).join('\n');
}

export function buildProposalPrompt(input: { analysis: AnalysisResult; brief: string; houseRules: string; refsList: string; tplPropose: string }): string {
  const analysisText = [
    `角色：${input.analysis.character || '（未确定）'}`,
    `作品：${input.analysis.work || '（未确定）'}`,
    input.analysis.aliases.length ? `别称：${input.analysis.aliases.join('、')}` : '',
    input.analysis.scene ? `场景：${input.analysis.scene}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return applyTemplate(input.tplPropose, {
    analysis: analysisText,
    brief: input.brief.trim() || '（未提供）',
    houseRules: input.houseRules.trim() || '（无）',
    refs: input.refsList,
  });
}

/** 未指定引用时，默认带上全部非分析类参考（供特效生成使用） */
export function defaultEffectRefs(materials: MaterialRow[]): string[] {
  return materials.filter((m) => m.role !== 'analysis' && m.role !== 'effect').map((m) => m.id);
}

function materialFileAbs(m: MaterialRow): string | null {
  if ((m.source === 'client' || m.source === 'web') && m.file_path) {
    const p = abs(m.file_path);
    return fs.existsSync(p) ? p : null;
  }
  if (m.source === 'library' && m.library_item_id) {
    const item = getDb().prepare('SELECT file_path FROM library_items WHERE id=?').get(m.library_item_id) as { file_path: string } | undefined;
    if (!item) return null;
    const p = abs(item.file_path);
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

export function listJobEffects(jobId: string): JobEffectRow[] {
  return getDb().prepare('SELECT * FROM job_effects WHERE job_id=? ORDER BY seq').all(jobId) as JobEffectRow[];
}

/** 用提案结果落库：替换未生成（ready）的特效条目，保留已生成/已入库的 */
export function materializeProposal(jobId: string, proposal: ProposalData, materials: MaterialRow[]): number {
  const db = getDb();
  const now = Date.now();
  db.prepare("DELETE FROM job_effects WHERE job_id=? AND status='ready'").run(jobId);
  const maxSeq = ((db.prepare('SELECT MAX(seq) AS m FROM job_effects WHERE job_id=?').get(jobId) as { m: number | null }).m ?? 0) as number;
  const defaults = defaultEffectRefs(materials);
  const insert = db.prepare(
    "INSERT INTO job_effects (id, job_id, seq, title, kind, gen_prompt, blend_prompt, ref_material_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)"
  );
  proposal.effects.forEach((e, i) => {
    const refs = e.refs.map((n) => materials[n - 2]?.id).filter((id): id is string => !!id);
    const refIds = refs.length ? refs : defaults;
    insert.run(randomUUID(), jobId, maxSeq + i + 1, e.title, e.kind, e.genPrompt, e.blendPrompt, JSON.stringify(refIds), now, now);
  });
  return proposal.effects.length;
}

function mockProposal(materials: MaterialRow[]): ProposalData {
  return {
    summary: '（模拟）围绕主体添加一层发光特效并轻微替换背景氛围',
    effects: [
      {
        title: '主体光效',
        kind: 'light',
        genPrompt: '在人物身体周围添加环绕的蓝紫色闪电弧光，光弧贴合动作走向，主要分布在身体两侧与身后，中心稍亮、边缘带辉光，受光与场图环境光方向一致。',
        blendPrompt: '本特效环绕在人物身后与两侧，人物位于前景遮挡中段光弧；光色偏冷，落地处补充微弱环境反光，亮度不压过人物面部。',
        refs: materials.length ? [2] : [],
      },
    ],
  };
}

/** 启动特效见解（异步执行；要求已有识别结果） */
export function startProposal(jobId: string): { status: 'running' | 'already_running' | 'no_analysis' } {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
  if (!job) throw Object.assign(new Error('客单不存在'), { statusCode: 404, code: 'JOB_NOT_FOUND' });
  const prep = ensurePrepRow(jobId);
  if (prep.proposal_status === 'running') return { status: 'already_running' };
  const analysisRaw = prep.analysis_result ? (JSON.parse(prep.analysis_result) as AnalysisResult) : null;
  if (!analysisRaw) return { status: 'no_analysis' };

  const settings = loadSettings();
  const analysisSettings = resolveAnalysisSettings(settings);
  const isWeb = settings.analysisProtocol === 'doubao-web';
  if (!isMockMode(settings) && !isWeb && !analysisSettings.apiKey) throw Object.assign(new Error('未配置分析服务 API Key（设置页「AI 筹备」，留空则沿用上方连接配置）'), { statusCode: 400, code: 'NO_API_KEY' });
  if (!isMockMode(settings) && !isWeb && !settings.analysisModelId.trim()) throw Object.assign(new Error('未配置分析模型 ID（设置页「AI 筹备」）'), { statusCode: 400, code: 'NO_ANALYSIS_MODEL' });

  const now = Date.now();
  db.prepare("UPDATE job_preps SET proposal_status='running', proposal_error=NULL, proposal_started_at=?, updated_at=? WHERE job_id=?").run(now, now, jobId);
  emitPrepUpdate({ jobId, kind: 'proposal', status: 'running', stage: '正在准备…' });

  void (async () => {
    let rawText = '';
    try {
      const materials = (db.prepare("SELECT * FROM job_materials WHERE job_id=? AND role != 'effect' ORDER BY order_index").all(jobId) as MaterialRow[]).filter(Boolean);
      let proposal: ProposalData;
      if (isMockMode(settings)) {
        await new Promise((r) => setTimeout(r, 1200));
        proposal = mockProposal(materials);
      } else {
        const images: VisionImage[] = [];
        const orig = await visionPartFromFile(abs(job.original_path), Math.min(settings.sendMaxDimension, 4096));
        if (orig) images.push(orig);
        for (const m of materials) {
          const fileAbs = materialFileAbs(m);
          if (!fileAbs) continue;
          const part = await visionPartFromFile(fileAbs, Math.min(settings.sendMaxDimension, 2048));
          if (part) images.push(part);
        }
        const prompt = buildProposalPrompt({
          analysis: analysisRaw,
          brief: job.brief ?? '',
          houseRules: settings.prepHouseRules,
          refsList: buildRefsList(materials),
          tplPropose: settings.tplPropose,
        });
        const res = await runVision({
          images,
          systemPrompt: '你是一位务实、克制、熟悉国内 cos 场照后期工作流的效果设计师。',
          userPrompt: prompt,
          settings: analysisSettings,
          context: `proposal:${jobId}`,
          onStage: (stage) => emitPrepUpdate({ jobId, kind: 'proposal', status: 'running', stage }),
        });
        rawText = res.text;
        proposal = normalizeProposal(extractJsonObject(res.text), materials.length);
      }
      const db2 = getDb();
      const materials2 = db2.prepare("SELECT * FROM job_materials WHERE job_id=? AND role != 'effect' ORDER BY order_index").all(jobId) as MaterialRow[];
      const count = materializeProposal(jobId, proposal, materials2);
      db2.prepare(
        "UPDATE job_preps SET proposal_status='done', proposal_result=?, proposal_raw=?, proposal_error=NULL, proposal_finished_at=?, updated_at=? WHERE job_id=?"
      ).run(JSON.stringify(proposal), rawText || null, Date.now(), Date.now(), jobId);
      logEvent('info', `特效见解完成：${count} 条建议`, { jobId });
      emitPrepUpdate({ jobId, kind: 'proposal', status: 'done' });
      emitJobUpdate(jobId);
    } catch (e) {
      const msg = e instanceof VisionError || e instanceof DoubaoError ? e.message : e instanceof Error ? e.message : String(e);
      getDb()
        .prepare("UPDATE job_preps SET proposal_status='failed', proposal_error=?, proposal_raw=?, proposal_finished_at=?, updated_at=? WHERE job_id=?")
        .run(msg, rawText || null, Date.now(), Date.now(), jobId);
      logEvent('warn', `特效见解失败：${msg}`, { jobId });
      emitPrepUpdate({ jobId, kind: 'proposal', status: 'failed', error: msg });
    }
  })();

  return { status: 'running' };
}

/* ---------------- 特效入库 ---------------- */

export interface ApproveEffectResult {
  itemId: string;
  refNo: number;
  title: string;
}

/** 审批通过：特效图入库（type=effect，带生成描述/融入说明）并加为当前客单参考图 */
export async function approveEffect(jobId: string, effectId: string): Promise<ApproveEffectResult> {
  const db = getDb();
  const effect = db.prepare('SELECT * FROM job_effects WHERE id=? AND job_id=?').get(effectId, jobId) as JobEffectRow | undefined;
  if (!effect) throw Object.assign(new Error('特效条目不存在'), { statusCode: 404, code: 'EFFECT_NOT_FOUND' });
  if (effect.status === 'approved' && effect.library_item_id) {
    const existing = db.prepare('SELECT order_index FROM job_materials WHERE job_id=? AND library_item_id=?').get(jobId, effect.library_item_id) as { order_index: number } | undefined;
    const title = (db.prepare('SELECT title FROM library_items WHERE id=?').get(effect.library_item_id) as { title: string } | undefined)?.title ?? effect.title;
    return { itemId: effect.library_item_id, refNo: existing?.order_index ?? 0, title };
  }
  if (effect.status !== 'review' || !effect.image_path) {
    throw Object.assign(new Error('特效图尚未生成完成，无法入库'), { statusCode: 400, code: 'EFFECT_NOT_READY' });
  }
  const srcAbs = abs(effect.image_path);
  if (!fs.existsSync(srcAbs)) throw Object.assign(new Error('特效图文件缺失'), { statusCode: 400, code: 'EFFECT_FILE_MISSING' });

  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
  const itemId = randomUUID();
  const targetRel = `library/effects/${itemId}.png`;
  const targetAbs = abs(targetRel);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  await sharp(srcAbs).png().toFile(targetAbs);

  const stats = await imageStats(targetAbs).catch(() => ({ width: 0, height: 0, background: null as string | null, colors: [] as { hex: string; name: string; share: number }[] }));
  const tags = [...new Set([
    ...(job?.character ? [job.character] : []),
    ...extractNouns([effect.title, effect.blend_prompt]).slice(0, 4),
    '特效预演',
  ])];
  const now = Date.now();
  db.prepare(
    "INSERT INTO library_items (id, type, file_path, job_id, title, tags_json, colors_json, source, favorite, status, width, height, background, prompt, blend_prompt, created_at) VALUES (?, 'effect', ?, ?, ?, ?, ?, 'ai', 0, 'active', ?, ?, ?, ?, ?, ?)"
  ).run(
    itemId,
    targetRel,
    jobId,
    effect.title || '特效预演',
    JSON.stringify(tags),
    JSON.stringify(stats.colors),
    stats.width,
    stats.height,
    stats.background === 'photo' ? null : stats.background,
    effect.gen_prompt,
    effect.blend_prompt,
    now
  );

  const materialId = randomUUID();
  const order = ((db.prepare('SELECT MAX(order_index) AS m FROM job_materials WHERE job_id=?').get(jobId) as { m: number | null }).m ?? 0) + 1;
  db.prepare("INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, 'library', ?, ?, NULL, ?, 'effect')").run(
    materialId,
    jobId,
    itemId,
    effect.title || '特效预演',
    order
  );
  db.prepare("UPDATE job_effects SET status='approved', library_item_id=?, updated_at=? WHERE id=?").run(itemId, now, effectId);

  logEvent('info', `特效已入库：${effect.title}（参考图 ${order}）`, { jobId });
  emitLibUpdate('effect-approved', itemId);
  emitPrepUpdate({ jobId, kind: 'effect', status: 'approved', effectId });
  emitJobUpdate(jobId);
  return { itemId, refNo: order, title: effect.title };
}
