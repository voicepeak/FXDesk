import { useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { cls, fmtCost, fmtDuration, fmtTime, JOB_GROUPS, STATUS_LABELS, statusGroup, taskStatusClass, taskStatusLabel } from '../util';
import type { JobSummary } from '../types';

export function StatusBadge({ status }: { status: JobSummary['status'] }) {
  return <span className={cls('status-badge', taskStatusClass(status))} title={STATUS_LABELS[status]}><span className="status-dot" />{taskStatusLabel(status)}</span>;
}

export default function JobsPage({ onNewJob }: { onNewJob(): void }) {
  const { jobs, navigate, toast, refreshJobs } = useStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(() => {
    const map: Record<string, JobSummary[]> = { ongoing: [], review: [], delivered: [] };
    const search = query.trim().toLocaleLowerCase();
    for (const job of [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (search && !(job.name + ' ' + job.character).toLocaleLowerCase().includes(search)) continue;
      map[statusGroup(job.status)].push(job);
    }
    return map;
  }, [jobs, query]);

  const clone = async (job: JobSummary) => {
    try {
      const next = await api.cloneJob(job.id);
      toast('已复用为新客单「' + next.name + '」', 'success');
      await refreshJobs();
      navigate({ name: 'editor', jobId: next.id });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const del = async (job: JobSummary) => {
    if (!window.confirm('删除客单「' + job.name + '」？文件将移入回收站。')) return;
    try {
      await api.deleteJob(job.id);
      toast('客单已移入回收站');
      await refreshJobs();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const open = (job: JobSummary) => navigate(job.status === 'review' || job.status === 'delivered' ? { name: 'review', jobId: job.id } : { name: 'editor', jobId: job.id });
  const visibleGroups = JOB_GROUPS.filter((group) => (filter === 'all' || filter === group.key) && grouped[group.key].length > 0);
  return (
    <div className="jobs-page">
      <div className="jobs-toolbar">
        <div><div className="page-eyebrow">WORKSPACE</div><h1 className="jobs-title">客单</h1><p className="page-description">{jobs.length} 个客单 · 按最近更新排列</p></div>
        <div className="spacer" />
        <button className="btn btn-primary jobs-new-mobile" onClick={onNewJob}>＋ 新建客单</button>
      </div>
      <div className="jobs-controls">
        <div className="jobs-filters" aria-label="筛选客单状态">
          {[{ key: 'all', title: '全部' }, ...JOB_GROUPS].map((group) => <button key={group.key} className={cls('jobs-filter', filter === group.key && 'active')} aria-pressed={filter === group.key} onClick={() => setFilter(group.key)}>{group.title}<span>{group.key === 'all' ? jobs.length : jobs.filter((job) => statusGroup(job.status) === group.key).length}</span></button>)}
        </div>
        <input className="input jobs-search" aria-label="搜索客单" placeholder="搜索客单名称、角色…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {visibleGroups.length > 0 && <div className="job-list-head"><span>客单</span><span>状态</span><span>更新时间</span><span>累计费用</span><span /></div>}
      {visibleGroups.map((group) => (
        <section className="jobs-section" key={group.key}>
          <button className="jobs-section-title" aria-expanded={!collapsed.has(group.key)} aria-controls={'job-list-' + group.key} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><span className={cls('group-chevron', !collapsed.has(group.key) && 'expanded')}>›</span>{group.title}<span className="section-count">{grouped[group.key].length}</span></button>
          <div className="jobs-list" id={'job-list-' + group.key} hidden={collapsed.has(group.key)}>
            {grouped[group.key].map((job) => (
              <div className="job-row" key={job.id}>
                <button className="job-row-open" onClick={() => open(job)} aria-label={'打开客单 ' + job.name}>
                  <span className="job-row-thumb">{job.thumb ? <img src={job.thumb} alt="" loading="lazy" /> : <span aria-hidden="true">▧</span>}</span>
                  <span className="job-row-info"><span className="job-card-name" title={job.name}>{job.name}</span><span className="job-row-sub">{job.character || '未设置角色'} · {job.materialCount} 个素材{job.lastRun?.elapsedMs != null ? ' · ' + fmtDuration(job.lastRun.elapsedMs) : ''}</span></span>
                </button>
                <StatusBadge status={job.status} />
                <time className="job-row-date" dateTime={new Date(job.updatedAt).toISOString()}>{fmtTime(job.updatedAt)}</time>
                <span className="job-row-cost">{fmtCost(job.costTotal)}</span>
                <details className="job-more"><summary aria-label={'更多操作 ' + job.name} title="更多操作">···</summary><div className="job-menu"><button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); void clone(job); }}>另存为</button><button className="danger" onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); void del(job); }}>删除客单</button></div></details>
              </div>
            ))}
          </div>
        </section>
      ))}
      {visibleGroups.length === 0 && <div className="jobs-empty"><span className="empty-symbol" aria-hidden="true">▤</span><h2>{jobs.length ? '没有匹配的客单' : '开始你的第一个客单'}</h2><p>{jobs.length ? '试试其他关键词或状态。' : '上传原图，添加素材，然后开始合成。'}</p>{jobs.length ? <button className="btn" onClick={() => { setQuery(''); setFilter('all'); }}>重置筛选</button> : <button className="btn" onClick={onNewJob}>选择原图</button>}</div>}
    </div>
  );
}
