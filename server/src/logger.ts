import fs from 'node:fs';
import { ws, ensureWorkspaceDirs } from './env';
import { getDb } from './db';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function logLine(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const ts = new Date().toISOString();
  const extra = meta === undefined ? '' : ` ${safeJson(meta)}`;
  const line = `${ts} [${level.toUpperCase()}] ${msg}${extra}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    ensureWorkspaceDirs();
    fs.appendFileSync(ws('logs', `app-${stamp()}.log`), line + '\n', 'utf8');
  } catch {
    /* console only */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function pruneLogs(maxDays = 7): void {
  try {
    const dir = ws('logs');
    const cutoff = Date.now() - maxDays * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const m = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (t < cutoff) fs.unlinkSync(ws('logs', f));
    }
  } catch {
    /* ignore */
  }
}

export function logEvent(level: 'info' | 'warn' | 'error', message: string, ids?: { jobId?: string; runId?: string }): void {
  try {
    getDb()
      .prepare('INSERT INTO events_log (ts, job_id, run_id, level, message) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), ids?.jobId ?? null, ids?.runId ?? null, level, message);
  } catch {
    /* ignore */
  }
  logLine(level, message, ids);
}
