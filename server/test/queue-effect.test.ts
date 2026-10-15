import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';

const held = vi.hoisted(() => ({
  calls: [] as { effectId: string; imageCount: number; prompt: string; model: string; aspectRatio?: string; baseUrl?: string; apiKey?: string }[],
  gates: new Map<string, () => void>(),
  block: false,
  failNext: false,
}));

vi.mock('../src/notify', () => ({ notifyComplete: vi.fn(), notifyFail: vi.fn() }));
vi.mock('../src/qc', () => ({ runIdentityCheck: async () => ({ identity: { status: 'skipped', sim: null }, shouldRepair: false }) }));
vi.mock('../src/momo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/momo')>()),
  generateWithFallback: vi.fn(async (opts: import('../src/momo').GenerateOptions) => {
    const id = /PROMPT:([\w-]+)/.exec(opts.prompt)?.[1] ?? 'unknown';
    held.calls.push({
      effectId: id,
      imageCount: opts.images.length,
      prompt: opts.prompt,
      model: opts.settings?.modelId ?? '',
      aspectRatio: opts.aspectRatio,
      baseUrl: opts.settings?.baseUrl,
      apiKey: opts.settings?.apiKey,
    });
    if (held.failNext) {
      held.failNext = false;
      throw new Error('mock fail');
    }
    if (held.block) {
      await new Promise<void>((resolve) => held.gates.set(id, resolve));
      held.gates.delete(id);
    }
    return { mime: opts.mockReturn!.mime, base64: opts.mockReturn!.base64, mocked: true };
  }),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-effect-'));
process.env.FXDESK_WORKSPACE = tmp;
import { getDb, openDb } from '../src/db';
import { defaultSettings, saveSettings } from '../src/settings';
import type { JobEffectRow, RunRow } from '../src/types';

afterAll(() => {
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
async function makeJob(id: string): Promise<void> {
  const db = getDb();
  const file = path.join(tmp, 'jobs', id, 'input', 'original.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 120, height: 160, channels: 3, background: '#334455' } }).png().toFile(file);
  db.prepare('INSERT INTO jobs (id, name, status, original_path, created_at, updated_at) VALUES (?, ?, \'draft\', ?, ?, ?)').run(
    id,
    id,
    `jobs/${id}/input/original.png`,
    Date.now(),
    Date.now()
  );
}

async function addMaterial(jobId: string): Promise<string> {
  const db = getDb();
  const mid = `mat-${++seq}`;
  const file = path.join(tmp, 'jobs', jobId, 'materials', 'client', `${mid}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 40, height: 40, channels: 3, background: '#aa5522' } }).png().toFile(file);
  db.prepare("INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index, role) VALUES (?, ?, 'client', NULL, ?, ?, ?, 'item')").run(
    mid,
    jobId,
    mid,
    `jobs/${jobId}/materials/client/${mid}.png`,
    1
  );
  return mid;
}

function addEffect(jobId: string, effectId: string, refIds: string[]): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO job_effects (id, job_id, seq, title, kind, gen_prompt, blend_prompt, ref_material_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'light', ?, ?, ?, 'ready', ?, ?)"
  ).run(effectId, jobId, ++seq, effectId, `PROMPT:${effectId} 在人物周围加闪电`, '本特效在人物身后', JSON.stringify(refIds), Date.now(), Date.now());
}

function enqueueEffect(jobId: string, effectId: string, runId: string): void {
  const db = getDb();
  db.prepare("INSERT INTO runs (id, job_id, seq, type, status, request_json, created_at) VALUES (?, ?, ?, 'effect', 'queued', ?, ?)").run(
    runId,
    jobId,
    ++seq,
    JSON.stringify({ effectId }),
    Date.now()
  );
  db.prepare("UPDATE job_effects SET status='queued', run_id=? WHERE id=?").run(runId, effectId);
}

const effect = (id: string) => getDb().prepare('SELECT * FROM job_effects WHERE id=?').get(id) as JobEffectRow;
const run = (id: string) => getDb().prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow;
const jobStatus = (id: string) => (getDb().prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status: string }).status;

describe('特效预演 Run（type=effect）', () => {
  it('成功：不改客单状态、不渲染标记、产物落盘、特效条目转待确认；特效服务商独立配置生效', async () => {
    openDb();
    saveSettings({
      ...defaultSettings(),
      mockApi: true,
      notifyToast: false,
      notifySound: false,
      effectBaseUrl: 'https://effect.example.com',
      effectApiKey: 'sk-effect-test',
      effectModelId: 'gpt-image-2.5-sunburst',
    });
    const { QueueManager } = await import('../src/queue');
    const manager = new QueueManager();

    await makeJob('job-e1');
    const m1 = await addMaterial('job-e1');
    addEffect('job-e1', 'fx-1', [m1]);
    enqueueEffect('job-e1', 'fx-1', 'run-fx1');
    manager.enqueue('job-e1', 'run-fx1');

    await vi.waitFor(() => expect(effect('fx-1').status).toBe('review'), { timeout: 8000 });

    const r = run('run-fx1');
    expect(r.status).toBe('done');
    expect(r.marker_path).toBeNull();
    expect(r.result_path).toBeTruthy();
    expect(fs.existsSync(path.join(tmp, r.result_path!))).toBe(true);
    expect(r.final_prompt).toContain('PROMPT:fx-1');
    expect(jobStatus('job-e1')).toBe('draft');

    const call = held.calls.find((c) => c.effectId === 'fx-1')!;
    expect(call.imageCount).toBe(2); // 场图 + 1 张参考
    expect(call.prompt).toContain('【本次附图】图1=场图');
    expect(call.prompt).toContain('图2=物品参照');
    expect(call.model).toBe('gpt-image-2.5-sunburst');
    expect(call.baseUrl).toBe('https://effect.example.com');
    expect(call.apiKey).toBe('sk-effect-test');
    expect(effect('fx-1').image_path).toBe(r.result_path);

    const request = JSON.parse(fs.readFileSync(path.join(tmp, `jobs/job-e1/02_runs/run_${String(r.seq).padStart(4, '0')}/request.json`), 'utf8'));
    expect(request.type).toBe('effect');
    expect(request.effectId).toBe('fx-1');
  });

  it('失败：特效条目标记失败并保留客单编辑中', async () => {
    const { QueueManager } = await import('../src/queue');
    const manager = new QueueManager();

    await makeJob('job-e2');
    addEffect('job-e2', 'fx-2', []);
    enqueueEffect('job-e2', 'fx-2', 'run-fx2');
    held.failNext = true;
    manager.enqueue('job-e2', 'run-fx2');

    await vi.waitFor(() => expect(effect('fx-2').status).toBe('failed'), { timeout: 8000 });
    expect(effect('fx-2').error).toContain('mock fail');
    expect(run('run-fx2').status).toBe('failed');
    expect(jobStatus('job-e2')).toBe('draft');
  });

  it('取消排队中的特效 Run：条目标回待生成，不影响客单状态', async () => {
    saveSettings({ ...defaultSettings(), mockApi: true, notifyToast: false, notifySound: false, queueConcurrency: 1 });
    const { QueueManager } = await import('../src/queue');
    const manager = new QueueManager();

    await makeJob('job-e3');
    addEffect('job-e3', 'fx-hold', []);
    enqueueEffect('job-e3', 'fx-hold', 'run-hold');
    held.block = true;
    manager.enqueue('job-e3', 'run-hold');
    await vi.waitFor(() => expect(held.gates.has('fx-hold')).toBe(true), { timeout: 8000 });

    addEffect('job-e3', 'fx-wait', []);
    enqueueEffect('job-e3', 'fx-wait', 'run-wait');
    manager.enqueue('job-e3', 'run-wait');
    await vi.waitFor(() => {
      expect(manager.snapshot().pending.some((p) => p?.runId === 'run-wait')).toBe(true);
    });
    expect(run('run-wait').status).toBe('queued');

    expect(manager.cancelRun('run-wait')).toEqual({ ok: true });
    expect(run('run-wait').status).toBe('canceled');
    expect(effect('fx-wait').status).toBe('ready');
    expect(jobStatus('job-e3')).toBe('draft');

    held.gates.get('fx-hold')!();
    held.block = false;
    await vi.waitFor(() => expect(effect('fx-hold').status).toBe('review'), { timeout: 8000 });
  });
});
