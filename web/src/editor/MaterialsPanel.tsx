import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import LibraryPicker from '../components/LibraryPicker';
import { cls } from '../util';
import type { Material } from '../types';

interface Props {
  jobId: string;
  materials: Material[];
  onChanged: () => void;
  softLimit: number;
}

export default function MaterialsPanel(props: Props) {
  const { toast } = useStore();
  const [showPicker, setShowPicker] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadFile = async (file: File) => {
    try {
      const r = await api.addMaterialFile(props.jobId, file);
      if (r.warning) toast(r.warning, 'info');
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            void uploadFile(f);
          }
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jobId]);

  const rename = async (mid: string) => {
    const name = editValue.trim();
    setEditingId(null);
    if (!name) return;
    try {
      await api.renameMaterial(props.jobId, mid, name);
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const del = async (m: Material) => {
    if (!window.confirm(`删除素材「${m.displayName}」？引用编号将自动更新。`)) return;
    try {
      const r = await api.deleteMaterial(props.jobId, m.id);
      toast(r.message ?? '素材已删除');
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const dropOn = async (target: Material) => {
    if (!dragId || dragId === target.id) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = props.materials.map((m) => m.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(target.id);
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    try {
      const r = await api.reorderMaterials(props.jobId, ids);
      toast(r.message ?? '顺序已更新');
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <>
      <div className="panel-head">
        素材
        <span className="chip chip-mini">{props.materials.length}</span>
        <div className="spacer" />
      </div>
      <div className="panel-scroll">
        <div className="add-drop" onClick={() => fileRef.current?.click()}>
          点击上传客户素材 / 粘贴图片 / 从素材库选择
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadFile(f);
          e.target.value = '';
        }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="btn btn-sm" onClick={() => setShowPicker(true)}>
            从素材库选择
          </button>
          <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>顺序即参考图编号</span>
        </div>

        {props.materials.map((m) => (
          <div
            key={m.id}
            className={cls('material-item', overId === m.id && 'drag-over')}
            draggable
            onDragStart={() => setDragId(m.id)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(m.id);
            }}
            onDragLeave={() => setOverId((v) => (v === m.id ? null : v))}
            onDrop={() => void dropOn(m)}
          >
            {m.fileUrl ? <img className="material-thumb" src={m.fileUrl} alt="" /> : <div className="material-thumb" />}
            <div className="material-info">
              <div className="material-refno">参考图{m.orderIndex}</div>
              {editingId === m.id ? (
                <input
                  className="material-name-input"
                  value={editValue}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => void rename(m.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename(m.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <div
                  className="material-name"
                  title="双击改名"
                  onDoubleClick={() => {
                    setEditingId(m.id);
                    setEditValue(m.displayName);
                  }}
                >
                  {m.displayName}
                </div>
              )}
              <div className="material-tags">
                <span className={cls('chip', 'chip-mini', m.source === 'client' ? 'chip-amber' : 'chip-green')}>
                  {m.source === 'client' ? '客户' : '库'}
                </span>
              </div>
            </div>
            <div className="material-ops">
              <button className="icon-btn" title="删除" onClick={() => void del(m)}>
                🗑
              </button>
            </div>
          </div>
        ))}
        {props.materials.length === 0 && <div className="empty-hint">暂无素材。区域指令中引用素材时会用到「参考图N」编号。</div>}
        {props.materials.length >= props.softLimit && (
          <div className="gen-reason">v1 建议不超过 {props.softLimit} 张参考图</div>
        )}
      </div>
      {showPicker && (
        <LibraryPicker
          onClose={() => setShowPicker(false)}
          onPick={async (item) => {
            setShowPicker(false);
            try {
              const r = await api.addMaterialLibrary(props.jobId, item.id, item.title);
              if (r.warning) toast(r.warning, 'info');
              props.onChanged();
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error');
            }
          }}
        />
      )}
    </>
  );
}
