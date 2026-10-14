import fs from 'node:fs';
import { ensureWorkspaceDirs, ws } from '../env';
import { loadSettings, saveSettings } from '../settings';
import { initDb } from '../db';

ensureWorkspaceDirs();
initDb();
const s = loadSettings(true);
if (!fs.existsSync(ws('config.json'))) {
  saveSettings(s);
  console.log(`[config] created: ${ws('config.json')}`);
} else {
  saveSettings(s);
  console.log(`[config] ok: ${ws('config.json')}`);
}
