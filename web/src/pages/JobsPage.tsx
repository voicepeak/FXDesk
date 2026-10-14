import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from '../components/Modal';
import { cls, fmtCost, fmtDuration, fmtTime, STATUS_LABELS, statusGroup } from '../util';
import type { JobSummary } from '../types';

const GROUPS: { key: 'ongoing' | 'review' | 'delivered' | 'failed'; title: string }[] = [
  { key: 'ongoing', title: '进行中' },
  { key: 'review', title: '待审核' },
  { key: 'delivered', title: '已交付' },
  { key: 'failed', title: '失败 / 已取消' },
];

export function StatusBadge({ status }: { status: JobSummary['status'] }) {
  return (
    <span className={cls('status-badge', `st-${status}`)}>
      <span className="status-dot" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export default function JobsPage() {
  const { jobs, navigate, toast, refreshJobs } = useStore();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const grouped = useMemo(() => {
    const map: Record<string, JobSummary[]> = { ongoing: [], review: [], delivered: [], failed: [] };
    for (const j of jobs) map[statusGroup(j.status)].push(j);
    return map;
  }, [jobs]);

  const create = async () => {
    if (!file) {
      toast('请选择原图（jpg / png / webp，≤50MB）', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.createJob(name, file);
      toast(`客单「${r.name}」已创建`, 'success');
      setShowNew(false);
      setName('');
      setFile(null);
      await refreshJobs();
      navigate({ name: 'editor', jobId: r.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (j: JobSummary) => {
    try {
      const r = await api.cloneJob(j.id);
      toast(`已复用为新客单「${r.name}」`, 'success');
      await refreshJobs();
      navigate({ name: 'editor', jobId: r.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const del = async (j: JobSummary) => {
    if (!window.confirm(`删除客单「${j.name}」？文件将移入回收站（trash），索引将被移除。`)) return;
    try {
      await api.deleteJob(j.id);
      toast('客单已删除（文件在 workspace/trash）');
      await refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const open = (j: JobSummary) => {
    navigate(j.status === 'review' || j.status === 'delivered' ? { name: 'review', jobId: j.id } : { name: 'editor', jobId: j.id });
  };

  return (
    <div className="jobs-page">
      <div className="jobs-toolbar">
        <div className="jobs-title">客单</div>
        <span className="muted">共 {jobs.length} 个</span>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          ＋ 新建客单
        </button>
      </div>

      {GROUPS.map((g) => (
        <div className="jobs-section" key={g.key}>
          <div className="jobs-section-title">
            {g.title}
            <span className="chip chip-mini">{grouped[g.key].length}</span>
          </div>
          <div className="jobs-grid">
            {grouped[g.key].map((j) => (
              <div className="job-card" key={j.id} onClick={() => open(j)}>
                <div className="job-thumb-wrap">{j.thumb && <img src={j.thumb} alt="" loading="lazy" />}</div>
                <div className="job-card-body">
                  <div className="job-card-name" title={j.name}>
                    {j.name}
                  </div>
                  <StatusBadge status={j.status} />
                  <div className="job-card-meta">
                    <span>{fmtTime(j.createdAt)}</span>
                    <span>
                      {j.lastRun?.elapsedMs != null ? `耗时 ${fmtDuration(j.lastRun.elapsedMs)}` : '—'} · {fmtCost(j.costTotal)}
                    </span>
                  </div>
                  <div className="job-card-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => clone(j)}>
                      另存为
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => del(j)}>
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {grouped[g.key].length === 0 && <div className="empty-hint">暂无</div>}
          </div>
        </div>
      ))}

      {showNew && (
        <Modal title="新建客单" onClose={() => setShowNew(false)}>
          <div className="form-row">
            <label className="label">客单名（留空自动按 日期-序号 命名）</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 2026-1014-01" autoFocus />
          </div>
          <div className="form-row">
            <label className="label">原图（jpg / png / webp，≤50MB）</label>
            <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp,image/*" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="btn" onClick={() => fileRef.current?.click()}>
              {file ? `已选择：${file.name}` : '选择原图文件…'}
            </button>
          </div>
          <div className="form-row" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowNew(false)}>
              取消
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
              {busy ? '创建中…' : '创建并进入编辑'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
