import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';

const held = vi.hoisted(() => ({ pending: new Map<string, () => void>(), active: 0, peak: 0, calls: [] as string[] }));
vi.mock('../src/notify', () => ({ notifyComplete: vi.fn(), notifyFail: vi.fn() }));
vi.mock('../src/qc', () => ({ runIdentityCheck: async () => ({ identity: { status: 'skipped', sim: null }, shouldRepair: false }) }));
vi.mock('../src/momo', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/momo')>(),
  generateWithFallback: vi.fn(async (opts: import('../src/momo').GenerateOptions) => {
    const jobId = opts.context!.jobId;
    held.calls.push(jobId); held.active++; held.peak = Math.max(held.peak, held.active);
    await new Promise<void>((resolve) => held.pending.set(jobId, resolve));
    held.pending.delete(jobId); held.active--;
    return { mime: opts.mockReturn!.mime, base64: opts.mockReturn!.base64, mocked: true };
  }),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-concurrency-'));
process.env.FXDESK_WORKSPACE = tmp;
import { getDb, openDb } from '../src/db';
import { defaultSettings, saveSettings } from '../src/settings';

afterAll(() => { getDb().close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('队列并发和取消（生成服务使用内存替身）', () => {
  it('4 笔同时生成，第 5 笔排队；取消的排队任务不会再调用生成接口', async () => {
    openDb(); saveSettings({ ...defaultSettings(), queueConcurrency: 4, mockApi: true, notifyToast: false, notifySound: false });
    const { QueueManager } = await import('../src/queue');
    const manager = new QueueManager();
    const db = getDb();
    for (let i = 1; i <= 5; i++) {
      const id = `job-${i}`;
      const relative = `jobs/${id}/input/original.png`;
      const file = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#334455' } }).png().toFile(file);
      db.prepare("INSERT INTO jobs (id,name,status,original_path,created_at,updated_at) VALUES (?,?,'queued',?,?,?)").run(id, id, relative, Date.now(), Date.now());
      db.prepare("INSERT INTO runs (id,job_id,seq,status,created_at) VALUES (?,?,1,'queued',?)").run(`run-${i}`, id, Date.now());
      manager.enqueue(id, `run-${i}`);
    }
    await vi.waitFor(() => expect(held.active).toBe(4));
    expect(manager.snapshot().active).toHaveLength(4);
    expect(manager.snapshot().pending).toHaveLength(1);
    expect(manager.cancelRun('run-5')).toEqual({ ok: true });
    for (const resolve of held.pending.values()) resolve();
    await vi.waitFor(() => expect(manager.snapshot().active).toHaveLength(0));
    expect(held.peak).toBe(4);
    expect(held.calls).toHaveLength(4);
    expect(held.calls).not.toContain('job-5');
    expect(db.prepare('SELECT status FROM runs WHERE id=?').get('run-5')).toEqual({ status: 'canceled' });
    expect((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='done'").get() as { count: number }).count).toBe(4);
  });
});
