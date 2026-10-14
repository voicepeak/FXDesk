import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { abs, getWorkspaceRoot, isInsideWorkspace } from './env';
import { getDb } from './db';
import type { RunRow } from './types';

export function getResultLocation(runId: string) {
  const run = getDb().prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
  if (!run) throw Object.assign(new Error('生成记录不存在'), { statusCode: 404, code: 'RUN_NOT_FOUND' });
  const stored = run.result_final_path || run.result_path;
  if (!stored) throw Object.assign(new Error('该次生成尚未保存结果文件'), { statusCode: 404, code: 'RESULT_NOT_FOUND' });
  const target = abs(stored);
  if (!isInsideWorkspace(target)) throw Object.assign(new Error('结果路径越界'), { statusCode: 403, code: 'FORBIDDEN' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw Object.assign(new Error('结果文件已移动或删除'), { statusCode: 404, code: 'RESULT_NOT_FOUND' });
  }
  const filePath = fs.realpathSync(target);
  const relative = path.relative(fs.realpathSync(getWorkspaceRoot()), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('结果路径越界'), { statusCode: 403, code: 'FORBIDDEN' });
  }
  return { filePath, folderPath: path.dirname(filePath), fileName: path.basename(filePath) };
}

export async function revealResult(runId: string) {
  const location = getResultLocation(runId);
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('自动打开文件位置目前仅支持 Windows，请复制路径打开'), { statusCode: 400, code: 'REVEAL_UNSUPPORTED' });
  }
  await new Promise<void>((resolve, reject) => {
    // No shell: paths containing spaces, Chinese characters or shell metacharacters stay literal.
    const child = spawn('explorer.exe', ['/select,', location.filePath], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true, ...location };
}
