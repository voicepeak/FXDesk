import type { BalanceInfo, Bbox, JobDetail, JobSummary, LibraryItem, QueueSnapshot, RefToken, Region, Settings } from './types';

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const e = (await r.json()) as { error?: { message?: string } };
      if (e?.error?.message) msg = e.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export interface RegionPayload {
  id: string;
  color: string;
  bbox: Bbox;
  instruction: string;
  refTokens: RefToken[];
}

export const api = {
  jobs: () => fetch('/api/jobs').then((r) => j<{ jobs: JobSummary[] }>(r)),
  job: (id: string) => fetch(`/api/jobs/${id}`).then((r) => j<JobDetail>(r)),
  createJob: (name: string, file: File) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('original', file);
    return fetch('/api/jobs', { method: 'POST', body: fd }).then((r) => j<{ id: string; name: string; width: number; height: number }>(r));
  },
  replaceOriginal: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('original', file);
    return fetch(`/api/jobs/${id}/original`, { method: 'POST', body: fd }).then((r) => j<{ ok: boolean }>(r));
  },
  patchJob: (id: string, patch: { name?: string; character?: string; global_instruction?: string }) =>
    fetch(`/api/jobs/${id}`, jsonInit('PATCH', patch)).then((r) => j<{ ok: boolean }>(r)),
  deleteJob: (id: string) => fetch(`/api/jobs/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  cloneJob: (id: string) => fetch(`/api/jobs/${id}/clone`, jsonInit('POST', {})).then((r) => j<{ id: string; name: string }>(r)),

  addMaterialFile: (jobId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`/api/jobs/${jobId}/materials`, { method: 'POST', body: fd }).then((r) => j<{ id: string; orderIndex: number; warning?: string | null }>(r));
  },
  addMaterialLibrary: (jobId: string, libraryItemId: string, displayName?: string) =>
    fetch(`/api/jobs/${jobId}/materials`, jsonInit('POST', { libraryItemId, displayName })).then((r) => j<{ id: string; orderIndex: number; warning?: string | null }>(r)),
  renameMaterial: (jobId: string, mid: string, displayName: string) =>
    fetch(`/api/jobs/${jobId}/materials/${mid}`, jsonInit('PATCH', { displayName })).then((r) => j<{ ok: boolean }>(r)),
  deleteMaterial: (jobId: string, mid: string) =>
    fetch(`/api/jobs/${jobId}/materials/${mid}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean; message?: string }>(r)),
  reorderMaterials: (jobId: string, ids: string[]) =>
    fetch(`/api/jobs/${jobId}/materials/order`, jsonInit('PUT', { ids })).then((r) => j<{ ok: boolean; message?: string }>(r)),

  putRegions: (jobId: string, regions: RegionPayload[]) => fetch(`/api/jobs/${jobId}/regions`, jsonInit('PUT', { regions })).then((r) => j<{ ok: boolean }>(r)),
  preview: (jobId: string) => fetch(`/api/jobs/${jobId}/prompt-preview`).then((r) => j<JobDetail['preview']>(r)),

  generate: (jobId: string, body?: { type?: string; baseRunId?: string }) =>
    fetch(`/api/jobs/${jobId}/generate`, jsonInit('POST', body ?? {})).then((r) => j<{ runId: string; seq: number; type: string }>(r)),
  repair: (jobId: string, baseRunId: string, regions: { color: string; bbox: Bbox; instruction: string }[]) =>
    fetch(`/api/jobs/${jobId}/repair`, jsonInit('POST', { baseRunId, regions })).then((r) => j<{ runId: string; seq: number }>(r)),
  deliver: (jobId: string, runId: string) =>
    fetch(`/api/jobs/${jobId}/deliver`, jsonInit('POST', { runId })).then((r) => j<{ finalPath: string; libraryItemId: string; tags: string[] }>(r)),

  queue: () => fetch('/api/queue').then((r) => j<QueueSnapshot>(r)),
  runLocation: (runId: string) => fetch(`/api/runs/${runId}/location`).then((r) => j<{ filePath: string; folderPath: string; fileName: string }>(r)),
  revealRun: (runId: string) => fetch(`/api/runs/${runId}/reveal`, jsonInit('POST', {})).then((r) => j<{ ok: boolean; filePath: string }>(r)),
  retryRun: (runId: string) => fetch(`/api/runs/${runId}/retry`, jsonInit('POST', {})).then((r) => j<{ runId: string; seq: number }>(r)),
  cancelRun: (runId: string) => fetch(`/api/runs/${runId}/cancel`, jsonInit('POST', {})).then((r) => j<{ ok: boolean }>(r)),
  saveElements: (runId: string, elements: { label: string; checked: boolean }[]) =>
    fetch(`/api/runs/${runId}/elements`, jsonInit('POST', { elements })).then((r) => j<{ ok: boolean }>(r)),
  saveReview: (runId: string, action: string, note: string) =>
    fetch(`/api/runs/${runId}/review`, jsonInit('POST', { action, note })).then((r) => j<{ ok: boolean }>(r)),

  library: (params: { q?: string; type?: string; favorite?: string; status?: string; zone?: string }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return fetch(`/api/library/items?${qs.toString()}`).then((r) => j<{ available: LibraryItem[]; history: LibraryItem[]; items: LibraryItem[] }>(r));
  },
  favoriteItem: (id: string, favorite: boolean) => fetch(`/api/library/items/${id}/favorite`, jsonInit('POST', { favorite })).then((r) => j<{ ok: boolean }>(r)),
  patchItem: (id: string, patch: { title?: string; tags?: string[]; status?: string }) => fetch(`/api/library/items/${id}`, jsonInit('PATCH', patch)).then((r) => j<{ ok: boolean }>(r)),
  deleteItem: (id: string) => fetch(`/api/library/items/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  importLibraryItem: (file: File, title: string, type: 'ref' | 'plate', tags: string[]) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', title);
    fd.append('type', type);
    fd.append('tags', JSON.stringify(tags));
    return fetch('/api/library/items', { method: 'POST', body: fd }).then((r) => j<LibraryItem>(r));
  },
  extractPlate: (jobId: string, effectDescription?: string) =>
    fetch('/api/library/extract-plate', jsonInit('POST', { jobId, effectDescription })).then((r) => j<{ itemId: string; description: string }>(r)),

  settings: () => fetch('/api/settings').then((r) => j<Settings>(r)),
  saveSettings: (patch: Partial<Settings>) => fetch('/api/settings', jsonInit('PUT', patch)).then((r) => j<Settings>(r)),
  testConnection: (apiKey?: string, baseUrl?: string) =>
    fetch('/api/settings/test-connection', jsonInit('POST', { apiKey, baseUrl })).then((r) => j<{ ok: boolean; models?: string[]; message?: string; error?: string }>(r)),
  balance: () => fetch('/api/balance').then((r) => j<BalanceInfo>(r)),
  emptyTrash: () => fetch('/api/trash/empty', jsonInit('POST', {})).then((r) => j<{ ok: boolean; removed: number }>(r)),
};

export type { Region };
