import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from '../components/Modal';
import { cls, fmtTime } from '../util';
import type { LibraryItem } from '../types';

type Tab = 'library' | 'favorites' | 'history';

function ColorDots({ colors }: { colors: LibraryItem['colors'] }) {
  return (
    <>
      {colors.slice(0, 3).map((c, i) => (
        <span key={i} className="color-dot" style={{ background: c.hex }} title={`${c.name} ${c.hex}`} />
      ))}
    </>
  );
}

export default function LibraryPage() {
  const { navigate, toast, libraryVersion, refreshJobs } = useStore();
  const [tab, setTab] = useState<Tab>('library');
  const [q, setQ] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [data, setData] = useState<{ available: LibraryItem[]; history: LibraryItem[] }>({ available: [], history: [] });
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editItem, setEditItem] = useState<LibraryItem | null>(null);
  const [plateItem, setPlateItem] = useState<LibraryItem | null>(null);
  const [plateDesc, setPlateDesc] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.library({
        q,
        zone: q ? undefined : tab,
        status: pendingOnly && tab === 'library' ? 'candidate' : undefined,
      });
      setData({ available: r.available, history: r.history });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab, pendingOnly]);

  useEffect(() => {
    void load();
  }, [load, libraryVersion]);

  const fav = async (it: LibraryItem) => {
    try {
      await api.favoriteItem(it.id, !it.favorite);
      toast(it.favorite ? '已取消收藏' : it.type === 'plate' && it.status === 'candidate' ? '⭐ 已收藏并升为正式素材' : '⭐ 已收藏');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const del = async (it: LibraryItem) => {
    if (!window.confirm(`删除素材「${it.title}」？（软删除，被客单引用时会被拒绝）`)) return;
    try {
      await api.deleteItem(it.id);
      toast('已删除');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const reuse = async (it: LibraryItem) => {
    if (!it.jobId) return;
    try {
      const r = await api.cloneJob(it.jobId);
      toast(`已复用配方创建客单「${r.name}」，请替换原图后生成`, 'success');
      void refreshJobs();
      navigate({ name: 'editor', jobId: r.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const openPlate = (it: LibraryItem) => {
    setPlateItem(it);
    setPlateDesc(it.tags.filter((t) => t !== '净版').join('、'));
  };

  const submitPlate = async () => {
    if (!plateItem?.jobId) return;
    try {
      await api.extractPlate(plateItem.jobId, plateDesc);
      toast('净版提取中（后台生成），稍后自动出现在素材库「待整理」', 'success');
      setPlateItem(null);
      window.setTimeout(() => void load(), 3000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const sections = useMemo(() => {
    if (q) return { available: data.available, history: data.history };
    if (tab === 'history') return { available: [], history: data.history };
    return { available: data.available, history: [] as LibraryItem[] };
  }, [q, tab, data]);

  return (
    <div className="library-page">
      <div className="lib-toolbar">
        <div className="tabs">
          <button className={cls('tab', tab === 'library' && 'active')} onClick={() => setTab('library')}>
            素材库
          </button>
          <button className={cls('tab', tab === 'favorites' && 'active')} onClick={() => setTab('favorites')}>
            收藏夹
          </button>
          <button className={cls('tab', tab === 'history' && 'active')} onClick={() => setTab('history')}>
            历史成果
          </button>
        </div>
        <input
          className="input search-input"
          placeholder="搜索：名称 / 标签 / 颜色（如「紫」）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {tab === 'library' && !q && (
          <button className={cls('btn btn-sm', pendingOnly && 'btn-primary')} onClick={() => setPendingOnly((v) => !v)}>
            待整理
          </button>
        )}
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
          ＋ 导入素材
        </button>
      </div>

      {loading && <div className="empty-hint">加载中…</div>}

      {!q && tab !== 'history' && (
        <div className="lib-grid">
          {sections.available.map((it) => (
            <div className="lib-card" key={it.id}>
              <button className={cls('lib-star', !it.favorite && 'off')} title="收藏" onClick={() => void fav(it)}>
                {it.favorite ? '★' : '☆'}
              </button>
              <img className="lib-thumb" src={it.fileUrl} alt="" loading="lazy" onClick={() => setEditItem(it)} />
              <div className="lib-card-body">
                <div className="lib-card-title" title={it.title}>
                  {it.title}
                </div>
                <div className="lib-card-meta">
                  <span className={cls('chip', 'chip-mini', it.type === 'plate' ? 'chip-blue' : 'chip-green')}>{it.type === 'plate' ? '净版' : '参考'}</span>
                  {it.status === 'candidate' && <span className="chip chip-mini chip-amber">待整理</span>}
                  {it.tags.slice(0, 2).map((t) => (
                    <span className="chip chip-mini" key={t}>
                      {t}
                    </span>
                  ))}
                  <ColorDots colors={it.colors} />
                </div>
                <div className="job-card-actions" style={{ opacity: 1 }}>
                  <button className="btn btn-sm" onClick={() => setEditItem(it)}>
                    编辑标签
                  </button>
                  <button className="btn btn-sm btn-ghost danger-text" onClick={() => void del(it)}>
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!loading && sections.available.length === 0 && <div className="empty-hint">暂无素材。点击右上角「入库」手动上传，或交付客单自动归档。</div>}
        </div>
      )}

      {(q || tab === 'history') && (
        <div>
          {sections.history.map((it) => (
            <div className="history-row" key={it.id}>
              <img className="history-thumb" src={it.fileUrl} alt="" loading="lazy" />
              <div className="history-info">
                <div className="lib-card-title" style={{ fontSize: 13.5 }}>
                  {it.title}
                </div>
                <div className="lib-card-meta">
                  <span className="chip chip-mini chip-violet">历史成果</span>
                  {it.tags.slice(0, 6).map((t) => (
                    <span className="chip chip-mini" key={t}>
                      {t}
                    </span>
                  ))}
                  <ColorDots colors={it.colors} />
                  <span className="muted" style={{ fontSize: 11 }}>
                    {fmtTime(it.createdAt)}
                  </span>
                </div>
                <div className="history-actions">
                  <button className="btn btn-sm" onClick={() => void reuse(it)}>
                    复用配方
                  </button>
                  <button className="btn btn-sm" onClick={() => openPlate(it)}>
                    提取净版
                  </button>
                  <button className="btn btn-sm" onClick={() => void fav(it)}>
                    {it.favorite ? '★ 已收藏' : '☆ 收藏'}
                  </button>
                  <button className="btn btn-sm" onClick={() => setEditItem(it)}>
                    编辑标签
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!loading && q && sections.history.length === 0 && <div className="lib-section-title">历史成果：无匹配</div>}
          {q && <div className="lib-section-title">可用素材（可直接从编辑页素材面板导入新客单）</div>}
          {q && (
            <div className="lib-grid">
              {sections.available.map((it) => (
                <div className="lib-card" key={it.id}>
                  <button className={cls('lib-star', !it.favorite && 'off')} onClick={() => void fav(it)}>
                    {it.favorite ? '★' : '☆'}
                  </button>
                  <img className="lib-thumb" src={it.fileUrl} alt="" loading="lazy" />
                  <div className="lib-card-body">
                    <div className="lib-card-title">{it.title}</div>
                    <div className="lib-card-meta">
                      <span className={cls('chip', 'chip-mini', it.type === 'plate' ? 'chip-blue' : 'chip-green')}>{it.type === 'plate' ? '净版' : '参考'}</span>
                      {it.tags.slice(0, 3).map((t) => (
                        <span className="chip chip-mini" key={t}>
                          {t}
                        </span>
                      ))}
                      <ColorDots colors={it.colors} />
                    </div>
                  </div>
                </div>
              ))}
              {!loading && sections.available.length === 0 && <div className="empty-hint">可用素材：无匹配</div>}
            </div>
          )}
        </div>
      )}

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void load(); }} />}

      {editItem && (
        <EditItemModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onDone={() => {
            setEditItem(null);
            void load();
          }}
        />
      )}

      {plateItem && (
        <Modal title="提取净版（惰性）" onClose={() => setPlateItem(null)}>
          <div className="form-row">
            <label className="label">特效描述（仅保留的特效内容）</label>
            <input className="input" value={plateDesc} onChange={(e) => setPlateDesc(e.target.value)} placeholder="如：闪电、魔法阵" autoFocus />
            <div className="form-hint">从成片中提取特效，生成纯黑背景的净版图。收藏后收入正式素材库。</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn" onClick={() => setPlateItem(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submitPlate()}>
              开始提取
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'ref' | 'plate'>('ref');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) {
      toast('请选择图片文件', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.importLibraryItem(
        file,
        title || file.name.replace(/\.[^.]+$/, ''),
        type,
        tags.split(/[,，、\s]+/).filter(Boolean)
      );
      toast('已入库', 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="手动入库" onClose={onClose}>
      <div className="form-row">
        <label className="label">图片文件</label>
        <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="form-row">
        <label className="label">名称</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：闪电" />
      </div>
      <div className="form-row">
        <label className="label">类型</label>
        <select className="select" value={type} onChange={(e) => setType(e.target.value as 'ref' | 'plate')}>
          <option value="ref">参考素材（ref）</option>
          <option value="plate">净版（plate）</option>
        </select>
      </div>
      <div className="form-row">
        <label className="label">标签（逗号分隔）</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：闪电, 黄色, 特效" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          入库
        </button>
      </div>
    </Modal>
  );
}

function EditItemModal({ item, onClose, onDone }: { item: LibraryItem; onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [title, setTitle] = useState(item.title);
  const [tags, setTags] = useState(item.tags.join(', '));

  const save = async () => {
    try {
      await api.patchItem(item.id, { title, tags: tags.split(/[,，、]+/).map((t) => t.trim()).filter(Boolean) });
      toast('已保存');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Modal title="编辑素材" onClose={onClose}>
      <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
        <img src={item.fileUrl} style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 8, background: '#000' }} alt="" />
        <div style={{ flex: 1 }}>
          <div className="kv-row">
            <span>类型</span>
            <span className="kv-val">{item.type === 'plate' ? '净版' : item.type === 'history' ? '历史成果' : '参考素材'}</span>
          </div>
          <div className="kv-row">
            <span>分辨率</span>
            <span className="kv-val">
              {item.width ?? '—'} × {item.height ?? '—'}
            </span>
          </div>
          <div className="kv-row">
            <span>底色</span>
            <span className="kv-val">{item.background ?? '—'}</span>
          </div>
          <div className="kv-row">
            <span>来源</span>
            <span className="kv-val">{item.source}</span>
          </div>
        </div>
      </div>
      <div className="form-row">
        <label className="label">名称</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">标签（逗号分隔）</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
    </Modal>
  );
}
