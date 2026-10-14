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

export interface Bbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  shape?: 'rect' | 'ellipse' | 'polygon' | 'lasso';
  /** Polygon vertices relative to this box, in the range 0–1. */
  points?: { x: number; y: number }[];
}

export type SelectionTool = 'select' | 'rect' | 'ellipse' | 'polygon' | 'lasso';

export interface RefToken {
  materialId: string;
  refNo: number;
  name: string;
}

export interface JobSummary {
  id: string;
  name: string;
  status: JobStatus;
  character: string;
  thumb: string | null;
  createdAt: number;
  updatedAt: number;
  costTotal: number;
  materialCount: number;
  regionCount: number;
  lastRun: { id: string; seq: number; type: string; status: string; elapsedMs: number | null; cost: number; error: string | null } | null;
}

export interface Material {
  id: string;
  source: 'client' | 'library' | 'web';
  libraryItemId: string | null;
  displayName: string;
  fileUrl: string | null;
  orderIndex: number;
}

export interface Region {
  id: string;
  idx: number;
  color: string;
  bbox: Bbox;
  instruction: string;
  refTokens: RefToken[];
}

export interface QcIdentity {
  status: 'pass' | 'mid' | 'fail' | 'skipped';
  sim: number | null;
  reason?: string | null;
  afterRepair?: { sim: number | null; status: string } | null;
}

export interface QcResult {
  identity: QcIdentity;
  composition: { ssim: number; phashDistance: number; verdict: 'ok' | 'shifted' } | null;
  elements: { confirmed: { label: string; checked: boolean }[] };
  faceRepair?: { triggered: boolean; runId?: string; status?: string; error?: string } | null;
}

export interface UpscaleInfo {
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

export interface Run {
  id: string;
  seq: number;
  type: 'initial' | 'rerun' | 'repair' | 'faceRepair';
  status: string;
  baseRunId: string | null;
  resultUrl: string | null;
  rawUrl: string | null;
  markerUrl: string | null;
  qc: QcResult | null;
  upscale: UpscaleInfo | null;
  finalPrompt: string | null;
  cost: number;
  elapsedMs: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface PromptBlock {
  kind: 'system' | 'region' | 'global' | 'ending';
  label: string;
  text: string;
  color?: string;
}

export interface JobDetail {
  job: {
    id: string;
    name: string;
    status: JobStatus;
    character: string;
    globalInstruction: string;
    originalUrl: string;
    finalRunId: string | null;
    costTotal: number;
    createdAt: number;
    updatedAt: number;
  };
  materials: Material[];
  regions: Region[];
  runs: Run[];
  preview: {
    blocks: PromptBlock[];
    finalPrompt: string;
    regionLines: { regionId: string; line: string }[];
    width: number;
    height: number;
  };
}

export interface LibraryItem {
  id: string;
  type: 'plate' | 'ref' | 'history';
  jobId: string | null;
  title: string;
  fileUrl: string;
  tags: string[];
  colors: { hex: string; name: string; share: number }[];
  source: string;
  favorite: boolean;
  status: 'candidate' | 'active';
  width: number | null;
  height: number | null;
  background: string | null;
  createdAt: number;
}

export interface Settings {
  apiKey: string;
  baseUrl: string;
  provider: 'auto' | 'momo' | 'grsai';
  modelId: string;
  imageSize: '1K' | '2K' | '4K';
  aspectRatio: string;
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

export interface QueueSnapshot {
  concurrency: number;
  pending: { jobId: string; runId: string; name: string; thumb: string | null; position: number }[];
  active: { jobId: string; runId: string; name: string; thumb: string | null; stage: string; elapsed: number; cost: number; startedAt: number; attempt?: number; message?: string; retryAt?: number; timeoutSec?: number; imageSize?: string }[];
  todayCost: number;
  monthlyCost: number;
  mock: boolean;
}

export interface BalanceInfo {
  balance: number;
  remainQuota: number;
  totalGranted: number;
  totalUsed: number;
}
