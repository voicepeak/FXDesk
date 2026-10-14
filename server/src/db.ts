import Database from 'better-sqlite3';
import { ensureWorkspaceDirs, ws } from './env';

const DDL = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  original_path TEXT NOT NULL,
  global_instruction TEXT DEFAULT '',
  character TEXT DEFAULT '',
  final_run_id TEXT,
  orig_width INTEGER,
  orig_height INTEGER,
  cost_total REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_materials (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  source TEXT NOT NULL,
  library_item_id TEXT,
  display_name TEXT NOT NULL,
  file_path TEXT,
  order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_regions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  idx INTEGER NOT NULL,
  color TEXT NOT NULL,
  bbox_json TEXT NOT NULL,
  instruction TEXT NOT NULL,
  ref_tokens TEXT DEFAULT '[]',
  is_repair INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'initial',
  status TEXT NOT NULL,
  base_run_id TEXT,
  marker_path TEXT,
  final_prompt TEXT,
  request_json TEXT,
  result_path TEXT,
  result_final_path TEXT,
  qc_json TEXT,
  upscale_json TEXT,
  cost REAL DEFAULT 0,
  elapsed_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  action TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  job_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  colors_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'internal',
  favorite INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  width INTEGER, height INTEGER,
  background TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  job_id TEXT,
  run_id TEXT,
  level TEXT,
  message TEXT
);
`;

let db: Database.Database | null = null;

function tableColumns(d: Database.Database, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** 老库增量迁移（PRD v1.1 附录 E：超分回填字段） */
function migrate(d: Database.Database): void {
  const jobCols = tableColumns(d, 'jobs');
  if (!jobCols.has('orig_width')) d.exec('ALTER TABLE jobs ADD COLUMN orig_width INTEGER');
  if (!jobCols.has('orig_height')) d.exec('ALTER TABLE jobs ADD COLUMN orig_height INTEGER');
  const runCols = tableColumns(d, 'runs');
  if (!runCols.has('upscale_json')) d.exec('ALTER TABLE runs ADD COLUMN upscale_json TEXT');
}

export function openDb(dbPath?: string): Database.Database {
  ensureWorkspaceDirs();
  const target = dbPath ?? ws('db.sqlite');
  const d = new Database(target);
  d.pragma('journal_mode = WAL');
  d.exec(DDL);
  migrate(d);
  db = d;
  return d;
}

export function initDb(dbPath?: string): string {
  openDb(dbPath);
  return dbPath ?? ws('db.sqlite');
}

export function getDb(): Database.Database {
  if (!db) openDb();
  return db!;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}
