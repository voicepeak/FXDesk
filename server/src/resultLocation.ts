import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { abs, getWorkspaceRoot, isInsideWorkspace } from './env';
import { getDb } from './db';
import { logLine } from './logger';
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

/**
 * 资源管理器窗口由桌面前台进程创建，前台锁（foreground lock）会让新窗口停在浏览器后面。
 * 这里在打开后定位对应窗口，并用 Alt 键解锁 + SetForegroundWindow 把它带到前台。
 */
function focusExplorerWindow(folderPath: string, filePath: string): void {
  const ps = (s: string) => s.replace(/'/g, "''");
  const focusLog = path.join(getWorkspaceRoot(), 'logs', 'reveal-focus.log');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$log = '${ps(focusLog)}'
[IO.File]::AppendAllText($log, ((Get-Date -Format o) + ' start' + [Environment]::NewLine))
Add-Type -Namespace FxDesk -Name Reveal -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$dir = '${ps(folderPath)}'
$file = '${ps(filePath)}'
$url = 'file:///' + $dir.Replace('\\', '/')
$sh = New-Object -ComObject Shell.Application
$hwnd = $null
$activated = $false
$tries = 0
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and -not $activated) {
  $target = $null
  $fallback = $null
  foreach ($w in $sh.Windows()) {
    $p = $null
    try { $p = $w.Document.Folder.Self.Path } catch { }
    if (-not $p) { $p = $w.LocationURL }
    if ($p -eq $dir -or $p -eq $url) {
      $fi = $null
      try { $fi = $w.Document.FocusedItem.Path } catch { }
      if ($fi -eq $file) { $target = $w; break }
      if (-not $fallback) { $fallback = $w }
    }
  }
  if (-not $target) { $target = $fallback }
  if ($target) {
    $hwnd = [IntPtr]$target.HWND
    $tries++
    [void][FxDesk.Reveal]::ShowWindow($hwnd, 9)
    [FxDesk.Reveal]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [FxDesk.Reveal]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][FxDesk.Reveal]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 150
    if ([FxDesk.Reveal]::GetForegroundWindow() -eq $hwnd) { $activated = $true; break }
    [FxDesk.Reveal]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 150
    if ([FxDesk.Reveal]::GetForegroundWindow() -eq $hwnd) { $activated = $true; break }
    Start-Sleep -Milliseconds 600
  } else {
    Start-Sleep -Milliseconds 250
  }
}
if ($hwnd -and -not $activated) {
  [void][FxDesk.Reveal]::ShowWindow($hwnd, 6)
  Start-Sleep -Milliseconds 400
  [void][FxDesk.Reveal]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 300
  if ([FxDesk.Reveal]::GetForegroundWindow() -eq $hwnd) { $activated = $true }
}
$result = 'notfound'
if ($hwnd) { $result = 'found-not-focused' }
if ($activated) { $result = 'activated' }
[IO.File]::AppendAllText($log, ((Get-Date -Format o) + ' result=' + $result + ' tries=' + $tries + ' hwnd=' + $hwnd + ' fg=' + [FxDesk.Reveal]::GetForegroundWindow() + ' folder=' + $dir + [Environment]::NewLine))
`;
  try {
    const powershellExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(
      powershellExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.once('error', (e) => logLine('warn', `打开文件位置：置前助手启动失败（${e.message}）`));
    child.unref();
  } catch (e) {
    logLine('warn', `打开文件位置：置前助手启动异常（${e instanceof Error ? e.message : String(e)}）`);
  }
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
  focusExplorerWindow(location.folderPath, location.filePath);
  return { ok: true, ...location };
}
