import { spawn } from 'node:child_process';
import notifier from 'node-notifier';
import { loadSettings } from './settings';
import { logLine } from './logger';

export function notifyComplete(jobName: string): void {
  notify('客单已完成待审核', `客单「${jobName}」已生成待审核`, 'complete');
}

export function notifyFail(jobName: string, error: string): void {
  notify('客单处理失败', `客单「${jobName}」失败：${error.slice(0, 120)}`, 'fail');
}

function notify(title: string, message: string, kind: 'complete' | 'fail'): void {
  const s = loadSettings();
  if (s.notifyToast) {
    try {
      notifier.notify({ title, message, sound: false, wait: false, timeout: 5 });
    } catch (e) {
      logLine('warn', '系统通知发送失败', String(e));
    }
  }
  if (s.notifySound) playSound(kind);
}

function playSound(kind: 'complete' | 'fail'): void {
  if (process.platform !== 'win32') return;
  const sound = kind === 'fail' ? 'Hand' : 'Asterisk';
  try {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[System.Media.SystemSounds]::${sound}.Play();`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    p.unref();
  } catch {
    /* ignore */
  }
}
