export interface JobRow {
  id: string;
  name: string;
  status: JobStatus;
  original_path: string;
  global_instruction: string;
  character: string;
  brief: string;
  final_run_id: string | null;
  orig_width: number | null;
  orig_height: number | null;
  cost_total: number;
  created_at: number;
  updated_at: number;
}

export type JobStatus =
  | 'draft'
  | 'queued'
  | 'generating'
  | 'qc'
  | 'review'
  | 'repairing'
  | 'failed'
  | 'delivered'
  | 'canceled';

export type MaterialRole = 'general' | 'analysis' | 'style' | 'item' | 'effect';

export interface MaterialRow {
  id: string;
  job_id: string;
  source: 'client' | 'library' | 'web';
  library_item_id: string | null;
  display_name: string;
  file_path: string | null;
  order_index: number;
  role: MaterialRole;
}

export interface Bbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  shape?: 'rect' | 'ellipse' | 'polygon' | 'lasso';
  points?: { x: number; y: number }[];
}

export interface RefToken {
  materialId: string;
  refNo: number;
  name: string;
}

export interface RegionRow {
  id: string;
  job_id: string;
  idx: number;
  color: string;
  bbox_json: string;
  instruction: string;
  ref_tokens: string;
  is_repair: number;
}

export type RunType = 'initial' | 'rerun' | 'repair' | 'faceRepair' | 'effect';
export type RunStatus = 'queued' | 'generating' | 'qc' | 'done' | 'failed' | 'canceled';

export interface RunRow {
  id: string;
  job_id: string;
  seq: number;
  type: RunType;
  status: RunStatus;
  base_run_id: string | null;
  marker_path: string | null;
  final_prompt: string | null;
  request_json: string | null;
  result_path: string | null;
  result_final_path: string | null;
  qc_json: string | null;
  upscale_json: string | null;
  cost: number;
  elapsed_ms: number | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface UpscaleRecord {
  engine: 'realesrgan' | 'lanczos';
  model?: string;
  degraded?: boolean;
  degradeReason?: string;
  from: string;
  to: string;
  scaleFactor: number;
  cropped: boolean;
  elapsedMs: number;
  iccPreserved?: boolean;
}

export interface LibraryItemRow {
  id: string;
  type: 'plate' | 'ref' | 'history' | 'effect';
  file_path: string;
  job_id: string | null;
  title: string;
  tags_json: string;
  colors_json: string;
  source: string;
  favorite: number;
  status: 'candidate' | 'active';
  width: number | null;
  height: number | null;
  background: string | null;
  prompt: string;
  blend_prompt: string;
  created_at: number;
}

export type PrepTaskStatus = 'idle' | 'running' | 'done' | 'failed';

export interface AnalysisResult {
  character: string;
  work: string;
  aliases: string[];
  scene: string;
  confidence: number | null;
  notes: string;
}

export interface JobPrepRow {
  id: string;
  job_id: string;
  analysis_status: PrepTaskStatus;
  analysis_result: string | null;
  analysis_raw: string | null;
  analysis_error: string | null;
  analysis_confirmed_at: number | null;
  analysis_started_at: number | null;
  analysis_finished_at: number | null;
  proposal_status: PrepTaskStatus;
  proposal_result: string | null;
  proposal_raw: string | null;
  proposal_error: string | null;
  proposal_started_at: number | null;
  proposal_finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export type EffectKind = 'light' | 'prop' | 'background' | 'other';

export type EffectStatus = 'ready' | 'queued' | 'generating' | 'review' | 'failed' | 'approved';

export interface JobEffectRow {
  id: string;
  job_id: string;
  seq: number;
  title: string;
  kind: EffectKind;
  gen_prompt: string;
  blend_prompt: string;
  ref_material_ids: string;
  status: EffectStatus;
  run_id: string | null;
  image_path: string | null;
  error: string | null;
  library_item_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface QcIdentity {
  status: 'pass' | 'mid' | 'fail' | 'skipped';
  sim: number | null;
  reason?: string | null;
  passThreshold?: number;
  midThreshold?: number;
  afterRepair?: { sim: number | null; status: string } | null;
  afterLock?: { sim: number | null; status: string } | null;
}

/** 锁脸（复制图层）结果：原图脸区对齐贴回 + 光照匹配 + 宽羽化 */
export interface QcFaceLock {
  applied: boolean;
  reason?: string;
  simBefore?: number | null;
  simAfter?: number | null;
  pass?: boolean;
  passThreshold?: number;
  /** aligned = 按对齐落点采样（默认）；detected = 检测器复检 */
  simMethod?: 'aligned' | 'detected';
  runId?: string;
  path?: string;
  expand?: number;
  feather?: number;
  angleDeg?: number;
  scale?: number;
  alignResidual?: number;
  lightMatch?: boolean;
  elapsedMs?: number;
}

export interface QcComposition {
  ssim: number;
  phashDistance: number;
  verdict: 'ok' | 'shifted';
}

export interface QcResult {
  identity: QcIdentity;
  composition: QcComposition | null;
  elements: { confirmed: { label: string; checked: boolean }[] };
  faceRepair?: { triggered: boolean; runId?: string; status?: string; error?: string } | null;
  faceLock?: QcFaceLock | null;
}
