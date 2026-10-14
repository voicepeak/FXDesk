import fs from 'node:fs';
import path from 'node:path';
import { logLine } from './logger';

/**
 * Windows + Node 24：路径含非 ASCII 字符时 fs.rmSync 会静默失效（不报错也不删除）。
 * 统一改用 readdir/unlink/rmdir 组合，确保中文路径下也能真实删除。
 */
export function removePath(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      removePath(path.join(target, name));
    }
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

export function removePathQuiet(target: string): void {
  try {
    removePath(target);
  } catch (e) {
    logLine('warn', `删除失败（已跳过）：${target}`, String(e));
  }
}
