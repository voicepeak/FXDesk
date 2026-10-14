import { useState } from 'react';
import { api } from '../api';
import { useStore, type Route } from '../store';
import { cls, fmtCost, fmtDuration, JOB_GROUPS, STATUS_LABELS, STAGE_LABELS, statusGroup, taskStatusClass } from '../util';
import type { JobStatus } from '../types';

export default function TaskBar({ onNewJob, onNavigate }: { onNewJob(): void; onNavigate(): void }) {
  const { route, queue, jobs, navigate: navigateTo, toast, refreshJobs, refreshQueue } = useStore();
  const navigate = (next: Route) => { navigateTo(next); onNavigate(); };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const active = queue?.active ?? [];
  const pending = queue?.pending ?? [];
  const tasks = jobs.map((job) => {
    const running = active.find((run) => run.jobId === job.id);
    const waiting = pending.find((run) => run.jobId === job.id);
    return { ...job, running, waiting, status: (running ? (['qc', 'repairing'].includes(running.stage) ? running.stage : 'generating') : waiting ? 'queued' : job.status) as JobStatus };
  });
  const runAction = async (runId: string, name: string, action: 'cancel' | 'retry') => {
    setBusyRun(runId);
    try {
      if (action === 'cancel') await api.cancelRun(runId);
      else await api.retryRun(runId);
      toast(action === 'cancel' ? (active.some((a) => a.runId === runId) ? '已停止「' + name + '」的本地等待；远端可能仍在处理，请核对记录' : '已取消「' + name + '」的排队') : '「' + name + '」已重新入队');
      await Promise.all([refreshQueue(), refreshJobs()]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyRun(null);
    }
  };
  const toggleGroup = (key: string) => setCollapsed((old) => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <aside className="taskbar" id="task-sidebar" aria-label="任务侧栏">
      <button className="icon-btn sidebar-close" aria-label="关闭任务侧栏" onClick={onNavigate}>×</button>
      <button className="sidebar-brand" onClick={() => navigate({ name: 'jobs' })}><span className="brand-mark" aria-hidden="true">F<span>×</span></span><span>FXDesk<span className="brand-caption">合成工作台</span></span></button>
      <button className="sidebar-new" onClick={onNewJob}><span aria-hidden="true">＋</span>新建客单</button>
      <nav className="sidebar-nav" aria-label="主导航">
        <button className={cls('sidebar-nav-item', ['jobs', 'editor', 'review'].includes(route.name) && 'active')} onClick={() => navigate({ name: 'jobs' })}><span aria-hidden="true">▤</span>全部客单<span className="sidebar-count">{jobs.length}</span></button>
        <button className={cls('sidebar-nav-item', route.name === 'library' && 'active')} onClick={() => navigate({ name: 'library' })}><span aria-hidden="true">▧</span>素材库</button>
      </nav>
      <div className="sidebar-section-label">任务</div>
      <div className="sidebar-tasks">
        {JOB_GROUPS.map((group) => {
          const items = tasks.filter((task) => statusGroup(task.status) === group.key);
          if (!items.length) return null;
          const isClosed = collapsed.has(group.key);
          return (
            <section className="sidebar-group" key={group.key}>
              <button className="sidebar-group-title" aria-expanded={!isClosed} aria-controls={'tasks-' + group.key} onClick={() => toggleGroup(group.key)}><span className={cls('group-chevron', !isClosed && 'expanded')}>›</span>{group.title}<span className="sidebar-count">{items.length}</span></button>
              <div id={'tasks-' + group.key} hidden={isClosed}>
                {items.map((job) => {
                  const selected = 'jobId' in route && route.jobId === job.id;
                  const runId = job.running?.runId ?? job.waiting?.runId;
                  const meta = job.running ? (job.running.message ?? STAGE_LABELS[job.running.stage] ?? '生成中') + ' · ' + fmtDuration(job.running.elapsed) : job.waiting ? '排队第 ' + job.waiting.position + ' 位' : STATUS_LABELS[job.status];
                  const error = job.status === 'failed' ? job.lastRun?.error : null;
                  return (
                    <div className={cls('sidebar-task', selected && 'selected')} key={job.id}>
                      <button className="sidebar-task-open" aria-current={selected ? 'page' : undefined} title={job.name + '\n' + (error ?? meta)} onClick={() => navigate(job.status === 'review' || job.status === 'delivered' ? { name: 'review', jobId: job.id } : { name: 'editor', jobId: job.id })}>
                        <span className={cls('sidebar-status-dot', taskStatusClass(job.status), !!job.running && 'is-running')} />
                        <span className="sidebar-task-name">{job.name}</span>
                        <span className="sr-only">{meta}</span>
                        <span className="sidebar-task-meta">{job.running ? fmtDuration(job.running.elapsed) : job.waiting ? '#' + job.waiting.position : job.status === 'failed' ? '失败' : job.status === 'canceled' ? '已取消' : ''}</span>
                      </button>
                      {job.running?.stage === 'retrying' && <span className="sidebar-task-notice">远端限流 · 等待重试</span>}
                      {job.running?.stage === 'generating' && job.running.elapsed >= 120000 && <span className="sidebar-task-notice">等待远端结果</span>}
                      {(runId || (job.status === 'failed' && job.lastRun)) && <button className="sidebar-task-action" disabled={busyRun === (runId ?? job.lastRun?.id)} aria-label={(runId ? '取消' : '重试') + ' ' + job.name} title={runId ? '取消任务' : '重试任务'} onClick={() => void runAction(runId ?? job.lastRun!.id, job.name, runId ? 'cancel' : 'retry')}>{runId ? '×' : '↻'}</button>}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
        {tasks.length === 0 && <div className="sidebar-empty">新建客单后，任务会显示在这里。</div>}
      </div>
      <footer className="sidebar-footer">
        <div className="sidebar-costs"><span>今日 <strong>{fmtCost(queue?.todayCost)}</strong></span><span>本月 {fmtCost(queue?.monthlyCost)}</span></div>
        <button className={cls('sidebar-nav-item', route.name === 'settings' && 'active')} onClick={() => navigate({ name: 'settings' })}><span aria-hidden="true">⚙</span>设置<span className="sidebar-count">并发 {queue?.concurrency ?? '—'}</span></button>
      </footer>
    </aside>
  );
}
