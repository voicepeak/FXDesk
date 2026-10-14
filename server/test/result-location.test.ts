import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: launch.spawn }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdesk-location-'));
process.env.FXDESK_WORKSPACE = tmp;
import { getDb, openDb } from '../src/db';
import { getResultLocation, revealResult } from '../src/resultLocation';

const relative = 'jobs/test/02_runs/run_0001/生成 图片 & 成品.jpg';
const file = path.join(tmp, relative);
beforeAll(() => {
  openDb(); const db = getDb();
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'image');
  db.prepare("INSERT INTO jobs (id,name,status,original_path,created_at,updated_at) VALUES ('job','job','review','input.png',0,0)").run();
  db.prepare("INSERT INTO runs (id,job_id,seq,status,result_path,created_at) VALUES ('run','job',1,'done',?,0)").run(relative);
  db.prepare("INSERT INTO runs (id,job_id,seq,status,created_at) VALUES ('empty','job',2,'generating',0)").run();
  db.prepare("INSERT INTO runs (id,job_id,seq,status,result_path,created_at) VALUES ('escape','job',3,'done','../../outside.jpg',0)").run();
});
afterAll(() => { getDb().close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('生成文件定位', () => {
  it('返回当前结果的完整路径，支持中文和空格', () => {
    expect(getResultLocation('run')).toEqual({ filePath: fs.realpathSync(file), folderPath: path.dirname(fs.realpathSync(file)), fileName: path.basename(file) });
  });
  it('不存在、尚未生成和越界的结果不会打开任何文件', () => {
    expect(() => getResultLocation('missing')).toThrow('生成记录不存在');
    expect(() => getResultLocation('empty')).toThrow('尚未保存');
    expect(() => getResultLocation('escape')).toThrow('路径越界');
    expect(launch.spawn).not.toHaveBeenCalled();
  });
  it('已删除文件返回明确提示', () => {
    const db = getDb();
    db.prepare("INSERT INTO runs (id,job_id,seq,status,result_path,created_at) VALUES ('deleted','job',4,'done','missing.jpg',0)").run();
    expect(() => getResultLocation('deleted')).toThrow('已移动或删除');
  });
  it.runIf(process.platform === 'win32')('以独立参数启动资源管理器并选中文件，不经过 shell', async () => {
    launch.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void }; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    });
    expect((await revealResult('run')).ok).toBe(true);
    expect(launch.spawn).toHaveBeenCalledWith('explorer.exe', ['/select,', fs.realpathSync(file)], { windowsHide: true, detached: true, stdio: 'ignore' });
  });
  it('接口可读取现有结果位置，拒绝外部网页触发资源管理器', async () => {
    const { registerRunsRoutes } = await import('../src/routes/runs');
    const app = Fastify(); registerRunsRoutes(app);
    const result = await app.inject({ method: 'GET', url: '/api/runs/run/location' });
    expect(result.statusCode).toBe(200);
    expect(result.json().filePath).toBe(fs.realpathSync(file));
    const blocked = await app.inject({ method: 'POST', url: '/api/runs/run/reveal', headers: { origin: 'https://external.example' } });
    expect(blocked.statusCode).toBe(403);
    await app.close();
  });
});
