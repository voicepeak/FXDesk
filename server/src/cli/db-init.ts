import { initDb } from '../db';
import { ensureWorkspaceDirs } from '../env';

ensureWorkspaceDirs();
const p = initDb();
console.log(`[db] initialized: ${p}`);
