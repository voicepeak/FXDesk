import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
const POINTER_FILE = path.join(PROJECT_ROOT, 'fxdesk.config.json');

export interface PointerConfig {
  workspacePath?: string;
}

export function readPointer(): PointerConfig {
  try {
    return JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8')) as PointerConfig;
  } catch {
    return {};
  }
}

export function writePointer(p: PointerConfig): void {
  fs.writeFileSync(POINTER_FILE, JSON.stringify(p, null, 2), 'utf8');
}

export function getWorkspaceRoot(): string {
  if (process.env.FXDESK_WORKSPACE) return path.resolve(process.env.FXDESK_WORKSPACE);
  const p = readPointer();
  if (p.workspacePath) {
    return path.isAbsolute(p.workspacePath) ? p.workspacePath : path.resolve(PROJECT_ROOT, p.workspacePath);
  }
  return path.join(PROJECT_ROOT, 'workspace');
}

/** Absolute path inside the workspace */
export function ws(...seg: string[]): string {
  return path.join(getWorkspaceRoot(), ...seg);
}

/** Workspace-relative path (forward slashes) from an absolute path */
export function rel(abs: string): string {
  return path.relative(getWorkspaceRoot(), abs).split(path.sep).join('/');
}

/** Absolute path from a workspace-relative path */
export function abs(relPath: string): string {
  return path.resolve(getWorkspaceRoot(), relPath);
}

export function ensureWorkspaceDirs(): void {
  const dirs = ['', 'jobs', 'library', 'library/history', 'library/plates', 'library/refs', 'trash', 'logs', 'models', 'demo', 'refsearch'];
  for (const d of dirs) fs.mkdirSync(ws(d), { recursive: true });
}

export function isInsideWorkspace(p: string): boolean {
  const root = path.resolve(getWorkspaceRoot());
  const target = path.resolve(p);
  const relp = path.relative(root, target);
  return relp === '' || (!relp.startsWith('..') && !path.isAbsolute(relp));
}
