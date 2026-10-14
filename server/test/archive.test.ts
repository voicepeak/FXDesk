import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-archive-'));
process.env.FXDESK_WORKSPACE = tmp;

import { getDb, openDb } from '../src/db';
import { deliverJob, extractPlate } from '../src/archive';
import { loadSettings, saveSettings } from '../src/settings';
import { imageStats } from '../src/tagging';

describe('净版 / recipe 归档（交付后 DB 与文件系统断言）', () => {
  it('交付 → 03_delivery、历史成果、标签（客单名+名词+主色）、recipe.json', async () => {
    openDb();
    const db = getDb();
    const jobId = '20261014-01';

    const inputDir = path.join(tmp, 'jobs', jobId, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    await sharp({ create: { width: 400, height: 600, channels: 3, background: '#334455' } }).png().toFile(path.join(inputDir, 'original.png'));

    const runDir = path.join(tmp, 'jobs', jobId, '02_runs', 'run_0001');
    fs.mkdirSync(runDir, { recursive: true });
    const resultAbs = path.join(runDir, 'result.png');
    await sharp({ create: { width: 400, height: 600, channels: 3, background: '#8E24AA' } }).png().toFile(resultAbs);

    const now = Date.now();
    db.prepare(
      "INSERT INTO jobs (id, name, status, original_path, global_instruction, character, cost_total, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, '', 0.3, ?, ?)"
    ).run(jobId, '2026-1014-01', `jobs/${jobId}/input/original.png`, '背景换成雨夜街道', now, now);
    db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
      'm1',
      jobId,
      'client',
      '剑',
      `jobs/${jobId}/materials/client/01_剑.png`,
      1
    );
    db.prepare('INSERT INTO job_materials (id, job_id, source, library_item_id, display_name, file_path, order_index) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
      'm2',
      jobId,
      'client',
      '闪电',
      `jobs/${jobId}/materials/client/02_闪电.png`,
      2
    );
    db.prepare('INSERT INTO job_regions (id, job_id, idx, color, bbox_json, instruction, ref_tokens, is_repair) VALUES (?, ?, 1, ?, ?, ?, ?, 0)').run(
      'r1',
      jobId,
      '#E53935',
      JSON.stringify({ x1: 10, y1: 10, x2: 100, y2: 100 }),
      '在手中添加参考图1的剑',
      JSON.stringify([{ materialId: 'm1', refNo: 1, name: '剑' }])
    );
    db.prepare('INSERT INTO job_regions (id, job_id, idx, color, bbox_json, instruction, ref_tokens, is_repair) VALUES (?, ?, 2, ?, ?, ?, ?, 0)').run(
      'r2',
      jobId,
      '#FDD835',
      JSON.stringify({ x1: 200, y1: 200, x2: 380, y2: 380 }),
      '身体周围加参考图2的闪电',
      JSON.stringify([{ materialId: 'm2', refNo: 2, name: '闪电' }])
    );
    const runId = 'run-1';
    db.prepare(
      'INSERT INTO runs (id, job_id, seq, type, status, base_run_id, final_prompt, result_path, result_final_path, cost, elapsed_ms, created_at, finished_at) VALUES (?, ?, 1, ?, ?, NULL, ?, ?, ?, 0.3, 65000, ?, ?)'
    ).run(runId, jobId, 'initial', 'done', '【最终提示词全文】', `jobs/${jobId}/02_runs/run_0001/result.png`, `jobs/${jobId}/02_runs/run_0001/result.png`, now, now);
    db.prepare('UPDATE jobs SET final_run_id=? WHERE id=?').run(runId, jobId);

    const r = await deliverJob(jobId, runId);

    // 文件系统断言
    expect(fs.existsSync(path.join(tmp, 'jobs', jobId, '03_delivery', 'final_v1.png'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'library', 'history', jobId, 'final.png'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'library', 'history', jobId, 'recipe.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'jobs', jobId, 'recipe.json'))).toBe(true);

    const recipe = JSON.parse(fs.readFileSync(path.join(tmp, 'library', 'history', jobId, 'recipe.json'), 'utf8'));
    expect(recipe.version).toBe(1);
    expect(recipe.regions.length).toBe(2);
    expect(recipe.regions[0].instruction).toContain('参考图1');
    expect(recipe.materials.length).toBe(2);
    expect(recipe.globalInstruction).toContain('雨夜街道');
    expect(recipe.finalPrompt).toContain('【最终提示词全文】');

    // DB 断言
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as { status: string };
    expect(job.status).toBe('delivered');

    const item = db.prepare("SELECT * FROM library_items WHERE job_id=? AND type='history'").get(jobId) as {
      id: string;
      tags_json: string;
      colors_json: string;
      status: string;
      title: string;
    };
    expect(item).toBeTruthy();
    expect(item.status).toBe('active');
    const tags = JSON.parse(item.tags_json) as string[];
    expect(tags).toContain('剑');
    expect(tags).toContain('闪电');
    expect(tags.some((t) => t.endsWith('色'))).toBe(true); // 主色（紫）
    expect(r.tags).toContain('剑');
    expect(r.tags).toContain('闪电');
  });

  it('惰性净版提取（mock 模式）→ candidate 黑底净版入库', async () => {
    const s = loadSettings();
    saveSettings({ ...s, mockApi: true });

    const db = getDb();
    const jobId = '20261014-01';
    const { itemId, description } = extractPlate(jobId, '闪电');
    expect(description).toBe('闪电');

    // 异步完成轮询
    const deadline = Date.now() + 20000;
    let row: { status: string; width: number | null; file_path: string; tags_json: string } | undefined;
    while (Date.now() < deadline) {
      row = db.prepare('SELECT status, width, file_path, tags_json FROM library_items WHERE id=?').get(itemId) as typeof row;
      if (row?.width) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(row?.width).toBeGreaterThan(0);
    expect(row?.status).toBe('candidate');

    const fileAbs = path.join(tmp, row!.file_path);
    expect(fs.existsSync(fileAbs)).toBe(true);
    const stats = await imageStats(fileAbs);
    expect(stats.background).toBe('black');
    const tags = JSON.parse(row!.tags_json) as string[];
    expect(tags).toContain('净版');
  });
});
