import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`[setup] ${m}`);

function run(cmd, args, required) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    if (required) {
      console.error(`[setup] 必需步骤失败：${cmd} ${args.join(' ')}`);
      process.exit(1);
    }
    log(`（非阻断：${cmd} ${args.join(' ')} 未成功，可稍后重试）`);
  }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`[setup] 需要 Node.js >= 22（当前 ${process.version}）`);
  process.exit(1);
}

log('安装依赖（npm install，首次较慢，含 sharp/better-sqlite3/onnxruntime 原生包）…');
run('npm', ['install', '--no-audit', '--no-fund'], true);

log('创建 workspace 目录并初始化数据库…');
run('npm', ['run', 'db:init', '-w', 'server'], true);

log('初始化设置文件 workspace/config.json…');
run('npm', ['run', 'init-config', '-w', 'server'], true);

log('下载质检模型（可选，失败不阻断，QC 降级为人工）…');
run('npm', ['run', 'setup-models', '-w', 'server'], false);

log('生成演示素材到 workspace/demo（可选）…');
run('npm', ['run', 'seed', '-w', 'server'], false);

log('完成。启动：npm run dev → 打开 http://localhost:5173');
