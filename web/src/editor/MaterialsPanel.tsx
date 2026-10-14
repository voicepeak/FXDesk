import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import LibraryPicker from '../components/LibraryPicker';
import RefSearchModal from '../components/RefSearchModal';
import { cls } from '../util';
import type { Material } from '../types';

interface Props {
  jobId: string;
  character: string;
  materials: Material[];
  onChanged: () => void;
  softLimit: number;
}

export default function MaterialsPanel(props: Props) {
  const { toast } = useStore();
  const [showPicker, setShowPicker] = useState(false);
  const [showRefSearch, setShowRefSearch] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [fileOver, setFileOver] = useState(false);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length || uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    let succeeded = 0;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress(`上传中 ${index + 1}/${files.length} · ${file.name}`);
        if (!/\.(jpe?g|png|webp|gif|tiff?|avif)$/i.test(file.name)) {
          toast(`${file.name}：支持 JPG、PNG、WebP、GIF、TIFF、AVIF 图片`, 'error');
          continue;
        }
        if (file.size > 50 * 1024 * 1024) {
          toast(`${file.name}：参考图不能超过 50 MB`, 'error');
          continue;
        }
        try {
          const r = await api.addMaterialFile(props.jobId, file);
          succeeded++;
          if (r.warning) toast(r.warning, 'info');
        } catch (e) {
          toast(`${file.name}：${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      }
      if (succeeded) {
        props.onChanged();
        toast(`已上传 ${succeeded} 张参考图`, 'success');
      }
    } finally {
      uploadLock.current = false;
      setUploading(false);
      setUploadProgress('');
    }
  }, [props.jobId, props.onChanged, toast]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            files.push(f);
          }
        }
      }
      if (files.length) { e.preventDefault(); void uploadFiles(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles]);

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
      <div className="panel-scroll" onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = uploading ? 'none' : 'copy'; setFileOver(true); }
      }} onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false);
      }} onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault(); setFileOver(false);
        void uploadFiles(Array.from(e.dataTransfer.files));
      }}>
        <button type="button" className={cls('add-drop reference-upload', fileOver && 'drag-over')} disabled={uploading} aria-label="上传参考图" onClick={() => fileRef.current?.click()}>
          {uploading ? uploadProgress : '＋ 点击或拖拽上传参考图'}
        </button>
        <div className="reference-upload-help" role="status">支持多选 / 粘贴 · 每张最多 50 MB<br />JPG、PNG、WebP、GIF、TIFF、AVIF</div>
        <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.avif" multiple disabled={uploading} aria-label="参考图文件" style={{ display: 'none' }} onChange={(e) => {
          void uploadFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="btn btn-sm" onClick={() => setShowPicker(true)}>
            从素材库选择
          </button>
          <button className="btn btn-sm" onClick={() => setShowRefSearch(true)}>
            网络搜参考
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
              if (e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              setOverId(m.id);
            }}
            onDragLeave={() => setOverId((v) => (v === m.id ? null : v))}
            onDrop={(e) => {
              if (e.dataTransfer.files.length) return;
              e.preventDefault(); e.stopPropagation(); void dropOn(m);
            }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
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
                <span className={cls('chip', 'chip-mini', m.source === 'client' ? 'chip-amber' : m.source === 'web' ? 'chip-blue' : 'chip-green')}>
                  {m.source === 'client' ? '客户' : m.source === 'web' ? '网络' : '库'}
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
      {showRefSearch && (
        <RefSearchModal
          jobId={props.jobId}
          initialKeyword={props.character}
          onClose={() => setShowRefSearch(false)}
          onImported={props.onChanged}
        />
      )}
    </>
  );
}
