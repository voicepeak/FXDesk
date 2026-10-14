export interface JobRow {
  id: string;
  name: string;
  status: JobStatus;
  original_path: string;
  global_instruction: string;
  character: string;
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

export interface MaterialRow {
  id: string;
  job_id: string;
  source: 'client' | 'library' | 'web';
  library_item_id: string | null;
  display_name: string;
  file_path: string | null;
  order_index: number;
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

export type RunType = 'initial' | 'rerun' | 'repair' | 'faceRepair';
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
  type: 'plate' | 'ref' | 'history';
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
  created_at: number;
}

export interface QcIdentity {
  status: 'pass' | 'mid' | 'fail' | 'skipped';
  sim: number | null;
  reason?: string | null;
  passThreshold?: number;
  midThreshold?: number;
  afterRepair?: { sim: number | null; status: string } | null;
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
}
