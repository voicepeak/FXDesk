import { useStore } from '../store';
import { fmtCost } from '../util';

export default function TopBar({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar(): void }) {
  const { route, navigate, jobs, balance, balanceError, settings, refreshBalance } = useStore();
  const currentJob = 'jobId' in route ? jobs.find((job) => job.id === route.jobId) : null;
  const title = route.name === 'library' ? '素材库' : route.name === 'settings' ? '设置' : '客单';
  return (
    <header className="topbar">
      <button className="icon-btn sidebar-toggle" aria-label={sidebarOpen ? '收起任务侧栏' : '展开任务侧栏'} aria-expanded={sidebarOpen} aria-controls="task-sidebar" onClick={onToggleSidebar}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
      </button>
      <div className="breadcrumb">
        <button onClick={() => navigate({ name: title === '客单' ? 'jobs' : route.name === 'library' ? 'library' : 'settings' })}>{title}</button>
        {currentJob && <><span className="breadcrumb-sep">/</span><span className="breadcrumb-current">{currentJob.name}</span><span className="breadcrumb-mode">{route.name === 'review' ? '审核' : '编辑'}</span></>}
      </div>
      <div className="topbar-right">
        {settings?.mockApi && <span className="mode-label"><span className="status-dot" />模拟模式</span>}
        <button className="balance-chip" onClick={() => void refreshBalance()} title="点击刷新余额" aria-label="刷新余额">
          <span className="balance-sub">余额</span>
          <span className="balance-amount">{balance ? fmtCost(balance.balance) : balanceError ? '不可用' : '加载中…'}</span>
          <span className="balance-refresh" aria-hidden="true">⟳</span>
        </button>
      </div>
    </header>
  );
}
