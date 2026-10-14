import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RefSearchItem, RefSearchStatus } from '../api';
import { useStore } from '../store';
import Modal from './Modal';
import { cls } from '../util';

interface Props {
  jobId: string;
  initialKeyword: string;
  onClose: () => void;
  onImported: () => void;
}

/** 与服务器同款 imageView2 放大规则：w 小于 1440 时提升到 1440。 */
function bigCdnUrl(u: string): string {
  return u.replace(/([?&]imageView2\/[^?#]*\/w\/)(\d+)(?=\/|$|&)/, (all, prefix: string, width: string) =>
    Number(width) >= 1440 ? all : `${prefix}1440`
  );
}

export default function RefSearchModal(props: Props) {
  const { toast } = useStore();
  const [kw, setKw] = useState(props.initialKeyword.trim());
  const [status, setStatus] = useState<RefSearchStatus | null>(null);
  const [items, setItems] = useState<RefSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RefSearchItem | null>(null);
  const [preview, setPreview] = useState<RefSearchItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const prevLoginState = useRef<string>('idle');

  const refreshStatus = useCallback(async (notify: boolean) => {
    try {
      const s = await api.refSearchStatus();
      setStatus(s);
      if (notify && s.loginState === 'done' && prevLoginState.current === 'waiting') {
        toast('小红书登录成功', 'success');
      }
      if (notify && s.loginState === 'error' && prevLoginState.current === 'waiting') {
        toast(s.loginError || '登录未完成，可重试', 'error');
      }
      prevLoginState.current = s.loginState;
    } catch {
      /* 状态查询失败不打断搜索 */
    }
  }, [toast]);

  const search = useCallback(
    async (keyword: string) => {
      const k = keyword.trim();
      if (!k || searching) return;
      setSearching(true);
      setError('');
      setSelected(null);
      try {
        const r = await api.refSearchSearch(k);
        setItems(r.items);
        if (!r.items.length) setError('没有搜到结果，换个关键词再试');
      } catch (e) {
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    },
    [searching]
  );

  useEffect(() => {
    void refreshStatus(false);
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.loginState !== 'waiting') return;
    const t = window.setInterval(() => void refreshStatus(true), 2500);
    return () => window.clearInterval(t);
  }, [status?.loginState, refreshStatus]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview]);

  const startLogin = async () => {
    try {
      const r = await api.refSearchLogin();
      toast(r.message, 'info');
      prevLoginState.current = 'waiting';
      setStatus((s) => (s ? { ...s, loginState: 'waiting' } : s));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const doImport = async (item?: RefSearchItem) => {
    const target = item ?? selected;
    if (!target || importing) return;
    setImporting(true);
    try {
      const r = await api.refSearchImport(props.jobId, target.thumbUrl, target.title);
      const importedId = target.id;
      setImportedIds((prev) => new Set(prev).add(importedId));
      toast(`已加入「${r.displayName}」（参考图${r.orderIndex}）`, 'success');
      if (r.warning) toast(r.warning, 'info');
      props.onImported();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setImporting(false);
    }
  };

  const loginWaiting = status?.loginState === 'waiting';
  const browserMissing = status !== null && !status.browserInstalled;

  return (
    <Modal title="搜参考图 · 小红书" onClose={props.onClose} width={880}>
      <div className="refsearch-toolbar">
        <input
          className="input"
          placeholder="输入角色名 / 关键词，如「明日香 场照」…"
          value={kw}
          autoFocus
          disabled={searching}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search(kw)}
        />
        <button className="btn btn-primary" disabled={searching || !kw.trim()} onClick={() => void search(kw)}>
          {searching ? '搜索中…' : '搜索'}
        </button>
        <button className="btn" disabled={loginWaiting || browserMissing || searching} onClick={() => void startLogin()}>
          {loginWaiting ? '等待扫码…' : '扫码登录'}
        </button>
      </div>
      {browserMissing && (
        <div className="refsearch-notice">
          浏览器组件未安装：请在项目目录执行 <code>npx playwright install chromium</code> 后重试
        </div>
      )}
      {loginWaiting && <div className="refsearch-notice">已打开登录窗口：请在弹出的浏览器中扫码；登录成功后窗口会自动关闭</div>}
      {status?.loginState === 'error' && status.loginError && <div className="refsearch-notice">{status.loginError}</div>}
      {error && <div className="refsearch-error">{error}</div>}
      {searching && items.length === 0 && <div className="empty-hint">正在搜索小红书，首次约需 5–15 秒…</div>}
      {!searching && items.length === 0 && !error && <div className="empty-hint">输入关键词后点击搜索。结果仅作参考图使用，请注意原作者版权。</div>}
      <div className="refsearch-grid">
        {items.map((it) => (
          <div
            key={it.id}
            role="button"
            tabIndex={0}
            className={cls('refsearch-card', selected?.id === it.id && 'selected')}
            onClick={() => setSelected(it)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelected(it);
              }
            }}
            title={it.title || '无标题'}
          >
            <img className="refsearch-thumb" src={api.refSearchThumb(it.thumbUrl)} alt="" loading="lazy" />
            {importedIds.has(it.id) && <span className="refsearch-done">已加入</span>}
            <button
              type="button"
              className="refsearch-zoom"
              title="放大预览"
              aria-label="放大预览"
              onClick={(e) => {
                e.stopPropagation();
                setPreview(it);
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M6.5 1a5.5 5.5 0 0 1 4.23 9.02l3.62 3.63a1 1 0 0 1-1.41 1.41l-3.63-3.62A5.5 5.5 0 1 1 6.5 1Zm0 1.8a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"
                />
              </svg>
            </button>
            <div className="refsearch-title">{it.title || '无标题'}</div>
          </div>
        ))}
      </div>
      {items.length > 0 && (
        <div className="refsearch-footer">
          {selected ? (
            <span>
              已选：<span className="refsearch-selname" title={selected.title}>{selected.title || '无标题'}</span>
            </span>
          ) : (
            <span className="muted">点击一张图片作为参考</span>
          )}
          <div className="spacer" />
          <button className="btn btn-primary" disabled={!selected || importing} onClick={() => void doImport()}>
            {importing ? '加入中…' : '加入为参考图'}
          </button>
        </div>
      )}
      {preview && (
        <div className="refsearch-lightbox" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="refsearch-lightbox-inner">
            <img src={api.refSearchThumb(bigCdnUrl(preview.thumbUrl))} alt="" />
            <div className="refsearch-lightbox-bar">
              <span className="refsearch-lightbox-title" title={preview.title}>
                {preview.title || '无标题'}
              </span>
              <div className="spacer" />
              <a className="refsearch-note-link" href={preview.noteUrl} target="_blank" rel="noreferrer">
                打开原帖
              </a>
              <button className="btn btn-sm" onClick={() => setPreview(null)}>
                关闭
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={importing || importedIds.has(preview.id)}
                onClick={() => {
                  setSelected(preview);
                  void doImport(preview);
                }}
              >
                {importedIds.has(preview.id) ? '已加入' : importing ? '加入中…' : '加入为参考图'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
