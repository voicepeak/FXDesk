import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { cls, fmtCost, fmtDuration, STAGE_LABELS } from '../util';

export default function TaskBar() {
  const { queue, jobs, navigate, toast, refreshJobs, refreshQueue } = useStore();
  const [open, setOpen] = useState(true);

  const pending = queue?.pending ?? [];
  const active = queue?.active ?? [];
  const failedJobs = jobs.filter((j) => j.status === 'failed').slice(0, 6);
  const reviewCount = jobs.filter((j) => j.status === 'review').length;
  const total = pending.length + active.length + failedJobs.length;

  const cancel = async (runId: string, name: string) => {
    try {
      await api.cancelRun(runId);
      toast(`已取消「${name}」`);
      void refreshQueue();
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const retry = async (runId: string, name: string) => {
    try {
      await api.retryRun(runId);
      toast(`「${name}」已重新入队`);
      void refreshQueue();
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div className={cls('taskbar', open && 'taskbar-open')}>
      <div className="taskbar-head">
        <button className="taskbar-toggle" onClick={() => setOpen((o) => !o)}>
          任务栏
          {total > 0 && <span className="badge-count">{total}</span>}
          {reviewCount > 0 && <span className="badge-count badge-review">{reviewCount} 待审核</span>}
          <span className="taskbar-caret">{open ? '▾' : '▴'}</span>
        </button>
        <div className="taskbar-costs">
          今日 {fmtCost(queue?.todayCost)} · 本月 {fmtCost(queue?.monthlyCost)} · 并发 {queue?.concurrency ?? '—'}
          {queue?.mock && <span className="chip chip-amber chip-mini">模拟</span>}
        </div>
      </div>
      {open && (
        <div className="taskbar-body">
          <div className="taskbar-cards">
            {active.map((a) => (
              <div className="task-card" key={a.runId}>
                {a.thumb && <img src={a.thumb} className="task-thumb" alt="" />}
                <div className="task-info">
                  <div className="task-name" title={a.name}>
                    {a.name}
                  </div>
                  <div className="task-meta">
                    <span className="pulse-dot" />
                    {STAGE_LABELS[a.stage] ?? a.stage} · 已耗时 {fmtDuration(a.elapsed)}
                  </div>
                  <div className="task-cost">累计 {fmtCost(a.cost)}</div>
                </div>
                <div className="task-actions">
                  <button className="btn btn-sm" onClick={() => void cancel(a.runId, a.name)}>
                    取消
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => navigate({ name: 'editor', jobId: a.jobId })}>
                    打开
                  </button>
                </div>
              </div>
            ))}
            {pending.map((p) => (
              <div className="task-card task-card-pending" key={p.runId}>
                {p.thumb && <img src={p.thumb} className="task-thumb" alt="" />}
                <div className="task-info">
                  <div className="task-name" title={p.name}>
                    {p.name}
                  </div>
                  <div className="task-meta">排队中（位置 {p.position}）</div>
                </div>
                <div className="task-actions">
                  <button className="btn btn-sm" onClick={() => void cancel(p.runId, p.name)}>
                    取消
                  </button>
                  <button className="btn btn-sm" onClick={() => navigate({ name: 'editor', jobId: p.jobId })}>
                    打开
                  </button>
                </div>
              </div>
            ))}
            {failedJobs.map((j) => (
              <div className="task-card task-card-failed" key={j.id}>
                {j.thumb && <img src={j.thumb} className="task-thumb" alt="" />}
                <div className="task-info">
                  <div className="task-name" title={j.name}>
                    {j.name}
                  </div>
                  <div className="task-meta task-error" title={j.lastRun?.error ?? ''}>
                    失败：{j.lastRun?.error ?? '未知错误'}
                  </div>
                </div>
                <div className="task-actions">
                  {j.lastRun && (
                    <button className="btn btn-sm" onClick={() => void retry(j.lastRun!.id, j.name)}>
                      重试
                    </button>
                  )}
                  <button className="btn btn-sm btn-primary" onClick={() => navigate({ name: 'editor', jobId: j.id })}>
                    打开
                  </button>
                </div>
              </div>
            ))}
            {total === 0 && <div className="taskbar-empty">暂无进行中的任务</div>}
          </div>
        </div>
      )}
    </div>
  );
}
