import { useStore } from '../store';
import { fmtCost } from '../util';

export default function TopBar() {
  const { route, navigate, balance, balanceError, settings, refreshBalance } = useStore();

  return (
    <header className="topbar">
      <div className="topbar-brand" onClick={() => navigate({ name: 'jobs' })}>
        <span className="logo-dot" />
        FXDesk
        <span className="brand-sub">后期特效合成工作台</span>
      </div>
      <nav className="topbar-nav">
        <button className={route.name === 'jobs' || route.name === 'editor' || route.name === 'review' ? 'nav-btn active' : 'nav-btn'} onClick={() => navigate({ name: 'jobs' })}>
          客单
        </button>
        <button className={route.name === 'library' ? 'nav-btn active' : 'nav-btn'} onClick={() => navigate({ name: 'library' })}>
          素材库
        </button>
        <button className={route.name === 'settings' ? 'nav-btn active' : 'nav-btn'} onClick={() => navigate({ name: 'settings' })}>
          设置
        </button>
      </nav>
      <div className="topbar-right">
        {settings?.mockApi && <span className="chip chip-amber" title="离线模拟模式：不调用真实 API（设置页可关闭）">模拟模式</span>}
        <button className="balance-chip" onClick={() => void refreshBalance()} title="点击刷新余额">
          {balance ? (
            <>
              <span className="balance-amount">{fmtCost(balance.balance)}</span>
              <span className="balance-sub">
                {balance.totalGranted > 0 ? `${Math.round((balance.remainQuota / balance.totalGranted) * 100)}%` : '—'}
              </span>
            </>
          ) : (
            <span className="balance-sub">{balanceError ? '余额不可用' : '余额加载中…'}</span>
          )}
          <span className="balance-refresh">⟳</span>
        </button>
      </div>
    </header>
  );
}
