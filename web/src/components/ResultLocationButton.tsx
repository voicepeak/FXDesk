import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from './Modal';

export default function ResultLocationButton({ runId, disabled = false, className = 'btn' }: { runId?: string | null; disabled?: boolean; className?: string }) {
  const { toast } = useStore();
  const [location, setLocation] = useState<{ filePath: string; folderPath: string; fileName: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const view = async () => {
    if (!runId) return;
    setLoading(true);
    try { setLocation(await api.runLocation(runId)); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setLoading(false); }
  };
  const reveal = async () => {
    if (!runId) return;
    setOpening(true);
    try { await api.revealRun(runId); toast('已打开资源管理器并选中生成文件', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setOpening(false); }
  };
  const copy = async () => {
    if (!location) return;
    try { await navigator.clipboard.writeText(location.filePath); toast('文件路径已复制', 'success'); }
    catch { toast('复制失败，请选中下方路径手动复制', 'error'); }
  };
  return <>
    <button className={className} disabled={disabled || !runId || loading} onClick={() => void view()}>{loading ? '读取位置…' : '查看生成文件位置'}</button>
    {location && <Modal title="生成文件位置" onClose={() => setLocation(null)}>
      <p className="location-name">{location.fileName}</p>
      <label className="label" htmlFor="result-file-path">完整文件路径</label>
      <textarea id="result-file-path" className="textarea location-path" rows={3} readOnly autoFocus value={location.filePath} onFocus={(e) => e.currentTarget.select()} />
      <p className="form-hint">文件保存在本机。打开位置后，资源管理器会选中当前版本的生成文件。</p>
      <div className="location-actions">
        <button className="btn btn-primary" disabled={opening} onClick={() => void reveal()}>{opening ? '打开中…' : '打开文件位置'}</button>
        <button className="btn" onClick={() => void copy()}>复制文件路径</button>
      </div>
    </Modal>}
  </>;
}
