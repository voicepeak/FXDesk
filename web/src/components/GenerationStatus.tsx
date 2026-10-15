import { useStore } from '../store';
import { cls, fmtDuration, STAGE_LABELS } from '../util';

export default function GenerationStatus({ jobId }: { jobId: string }) {
  const { queue, jobs } = useStore();
  const run = queue?.active.find((a) => a.jobId === jobId);
  const waiting = queue?.pending.find((a) => a.jobId === jobId);
  const job = jobs.find((j) => j.id === jobId);
  if (!run && !waiting) {
    return job?.status === 'failed' && job.lastRun?.error ? <div className="generation-status is-slow" role="status"><strong>本次生成未完成</strong><span>{job.lastRun.error}</span></div> : null;
  }
  if (!run) return <div className="generation-status" role="status"><strong>排队第 {waiting!.position} 位</strong><span>当前最多同时处理 {queue?.concurrency} 笔客单</span></div>;
  const isEffect = run.runType === 'effect';
  const slow = run.elapsed >= 120000 && run.stage === 'generating';
  const retrySeconds = run.retryAt ? Math.max(0, Math.ceil((run.retryAt - Date.now()) / 1000)) : 0;
  const base = run.stage === 'retrying' ? `远端限流 · ${retrySeconds} 秒后重试` : slow ? '远端生成等待较久' : STAGE_LABELS[run.stage] ?? '生成中';
  const title = isEffect ? `特效预演 · ${base}` : base;
  return <div className={cls('generation-status', (slow || run.stage === 'retrying') && 'is-slow')} role="status">
    <div className="generation-status-title"><strong>{title}</strong><span>{run.imageSize} · 已用 {fmtDuration(run.elapsed)}</span></div>
    <span>{run.stage === 'generating' ? `${run.message ?? '等待远端生成结果'}。最长等待 ${Math.round((run.timeoutSec ?? 600) / 60)} 分钟，期间无需重复提交。` : run.message ?? '任务仍在处理中，可继续操作其他客单。'}</span>
  </div>;
}
