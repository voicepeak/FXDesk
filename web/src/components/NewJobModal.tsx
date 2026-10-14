import { useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from './Modal';

export default function NewJobModal({ onClose }: { onClose(): void }) {
  const { navigate, toast, refreshJobs } = useStore();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const create = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const job = await api.createJob(name, file);
      toast(`客单「${job.name}」已创建`, 'success');
      await refreshJobs();
      navigate({ name: 'editor', jobId: job.id });
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="新建客单" onClose={() => !busy && onClose()}>
      <div className="form-row">
        <label className="label" htmlFor="new-job-name">客单名称</label>
        <input id="new-job-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="留空按日期自动命名" autoFocus />
      </div>
      <div className="form-row">
        <label className="label">原图</label>
        <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="add-drop new-job-upload" onClick={() => fileRef.current?.click()}>
          <span>{file ? file.name : '＋ 选择原图'}</span>
          <span className="form-hint">JPG / PNG / WebP · 最大 50 MB</span>
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy || !file} onClick={() => void create()}>{busy ? '创建中…' : '创建并进入编辑'}</button>
      </div>
    </Modal>
  );
}
