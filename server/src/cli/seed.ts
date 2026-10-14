import fs from 'node:fs';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { ensureWorkspaceDirs, rel, ws } from '../env';
import { getDb, initDb } from '../db';
import { imageStats } from '../tagging';
import type { LibraryItemRow } from '../types';

ensureWorkspaceDirs();
initDb();

const demoDir = ws('demo');
fs.mkdirSync(demoDir, { recursive: true });

async function makePhoto(): Promise<string> {
  const W = 1200;
  const H = 1600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2350"/>
      <stop offset="0.55" stop-color="#6b3f79"/>
      <stop offset="1" stop-color="#242038"/>
    </linearGradient>
    <radialGradient id="moon" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#f7f3e3"/>
      <stop offset="1" stop-color="#f7f3e3" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="880" cy="330" r="180" fill="url(#moon)" opacity="0.55"/>
  <circle cx="880" cy="330" r="72" fill="#f2ecd8" opacity="0.9"/>
  <rect y="${H - 420}" width="${W}" height="420" fill="#171226"/>
  <path d="M0 ${H - 420} L180 ${H - 560} L420 ${H - 400} L700 ${H - 590} L980 ${H - 420} L${W} ${H - 540} L${W} ${H} L0 ${H} Z" fill="#1d1630"/>
  <g>
    <ellipse cx="600" cy="${H - 340}" rx="180" ry="360" fill="#3a2340"/>
    <ellipse cx="600" cy="${H - 340}" rx="110" ry="300" fill="#4c2c52"/>
    <circle cx="600" cy="700" r="110" fill="#e8c39e"/>
    <path d="M470 700 q130 -230 260 0 q20 -180 -130 -200 q-150 20 -130 200 Z" fill="#2a1a33"/>
    <circle cx="560" cy="690" r="10" fill="#33221f"/>
    <circle cx="640" cy="690" r="10" fill="#33221f"/>
    <path d="M565 745 q35 24 70 0" stroke="#a5555a" stroke-width="6" fill="none" stroke-linecap="round"/>
  </g>
  <g opacity="0.8">
    <rect x="420" y="${H - 620}" width="360" height="40" rx="18" fill="#5a2f63"/>
  </g>
  <text x="600" y="1500" font-size="42" font-family="sans-serif" fill="#8f86b3" text-anchor="middle" opacity="0.7">FXDesk 演示场照</text>
  </svg>`;
  const out = ws('demo', 'demo-photo.jpg');
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(out);
  return out;
}

async function makeSword(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <path d="M300 40 L330 120 L322 380 L338 400 L338 440 L262 440 L262 400 L278 380 L270 120 Z" fill="#c9d2dd" stroke="#8a97a8" stroke-width="6"/>
  <path d="M300 40 L322 380 L300 380 Z" fill="#eef2f7" opacity="0.85"/>
  <rect x="230" y="440" width="140" height="28" rx="10" fill="#c9a227"/>
  <rect x="286" y="468" width="28" height="96" rx="12" fill="#5b3a1e"/>
  <circle cx="300" cy="572" r="16" fill="#c9a227"/>
  </svg>`;
  const out = ws('demo', 'demo-sword.png');
  await sharp(Buffer.from(svg)).png().toFile(out);
  return out;
}

async function makeLightning(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
  <rect width="800" height="800" fill="#000000"/>
  <polygon points="470,90 340,430 440,430 300,740 560,380 460,380 590,90" fill="#FDD835" opacity="0.95"/>
  <polygon points="465,140 370,395 445,395 350,650 505,375 435,375 540,140" fill="#fff3b0" opacity="0.6"/>
  </svg>`;
  const out = ws('demo', 'demo-lightning.png');
  await sharp(Buffer.from(svg)).png().toFile(out);
  return out;
}

const photo = await makePhoto();
const sword = await makeSword();
const lightning = await makeLightning();
console.log(`[seed] demo assets: ${photo}\n  ${sword}\n  ${lightning}`);

const db = getDb();
const existing = db.prepare("SELECT * FROM library_items WHERE title = '闪电' AND status != 'deleted'").get() as LibraryItemRow | undefined;
if (!existing) {
  const id = randomUUID();
  const stats = await imageStats(lightning);
  const tags = ['闪电', '特效', '黄色'];
  db.prepare(
    "INSERT INTO library_items (id, type, file_path, job_id, title, tags_json, colors_json, source, favorite, status, width, height, background, created_at) VALUES (?, 'ref', ?, NULL, '闪电', ?, ?, 'manual', 0, 'active', ?, ?, ?, ?)"
  ).run(id, rel(lightning), JSON.stringify(tags), JSON.stringify(stats.colors), stats.width, stats.height, stats.background, Date.now());
  console.log(`[seed] library item created: 闪电 (${id})`);
} else {
  console.log(`[seed] library item already exists: 闪电 (${existing.id})`);
}
