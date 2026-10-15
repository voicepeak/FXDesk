import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LibraryItem } from '../types';
import Modal from './Modal';
import { cls } from '../util';

export default function LibraryPicker(props: { onPick: (item: LibraryItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .library({ q, zone: 'library' })
        .then((r) => alive && setItems(r.available))
        .catch(() => alive && setItems([]))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  return (
    <Modal title="从素材库选择" onClose={props.onClose} width={680}>
      <input className="input" placeholder="搜索素材（名称 / 标签 / 颜色）…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="picker-grid">
        {items.map((it) => (
          <button key={it.id} className="picker-card" onClick={() => props.onPick(it)} title={it.title}>
            <img src={it.fileUrl} className="picker-thumb" alt="" />
            <div className="picker-name">{it.title}</div>
            <div className="picker-tags">
              <span className={cls('chip', 'chip-mini', it.type === 'plate' ? 'chip-blue' : it.type === 'effect' ? 'chip-violet' : 'chip-green')}>{it.type === 'plate' ? '净版' : it.type === 'effect' ? '特效' : '参考'}</span>
              {it.tags.slice(0, 2).map((t) => (
                <span key={t} className="chip chip-mini">
                  {t}
                </span>
              ))}
            </div>
          </button>
        ))}
        {!loading && items.length === 0 && <div className="empty-hint">没有匹配的素材。可先到「素材库」页手动入库。</div>}
        {loading && <div className="empty-hint">加载中…</div>}
      </div>
    </Modal>
  );
}
