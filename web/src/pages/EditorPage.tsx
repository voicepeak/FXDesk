import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import AnnotationCanvas from '../editor/AnnotationCanvas';
import MaterialsPanel from '../editor/MaterialsPanel';
import PromptPanel from '../editor/PromptPanel';
import GenerationStatus from '../components/GenerationStatus';
import ResultLocationButton from '../components/ResultLocationButton';
import { StatusBadge } from './JobsPage';
import { cls, paletteColor } from '../util';
import type { Bbox, JobDetail, Region, SelectionTool } from '../types';

export default function EditorPage({ jobId }: { jobId: string }) {
  const { navigate, toast, settings, refreshJobs, jobs } = useStore();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [preview, setPreview] = useState<JobDetail['preview'] | null>(null);
  const [tool, setTool] = useState<SelectionTool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [genBusy, setGenBusy] = useState(false);
  const [saved, setSaved] = useState(true);
  const [nameDraft, setNameDraft] = useState('');
  const regionTimer = useRef<number | null>(null);
  const globalTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.job(jobId);
      setDetail(d);
      setRegions(d.regions);
      setPreview(d.preview);
      setNameDraft(d.job.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      navigate({ name: 'jobs' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const persistRegions = useCallback(
    (next: Region[], delay = 450) => {
      setRegions(next);
      setSaved(false);
      if (regionTimer.current) window.clearTimeout(regionTimer.current);
      regionTimer.current = window.setTimeout(async () => {
        try {
          await api.putRegions(
            jobId,
            next.map((r) => ({ id: r.id, color: r.color, bbox: r.bbox, instruction: r.instruction, refTokens: r.refTokens }))
          );
          const p = await api.preview(jobId);
          setPreview(p);
          setSaved(true);
        } catch (e) {
          setSaved(true);
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      }, delay);
    },
    [jobId, toast]
  );

  const clampBbox = useCallback(
    (b: Bbox): Bbox => {
      const W = preview?.width ?? 0;
      const H = preview?.height ?? 0;
      const w = Math.min(W || Infinity, Math.abs(b.x2 - b.x1));
      const h = Math.min(H || Infinity, Math.abs(b.y2 - b.y1));
      const x1 = Math.max(0, Math.min(Math.min(b.x1, b.x2), W ? W - w : Infinity));
      const y1 = Math.max(0, Math.min(Math.min(b.y1, b.y2), H ? H - h : Infinity));
      return { ...b, x1, y1, x2: x1 + w, y2: y1 + h };
    },
    [preview]
  );

  const addRegion = useCallback(
    (bbox: Bbox) => {
      const r: Region = {
        id: crypto.randomUUID(),
        idx: regions.length + 1,
        color: paletteColor(regions.length),
        bbox,
        instruction: '',
        refTokens: [],
      };
      persistRegions([...regions, r], 0);
      setSelectedId(r.id);
      setTool('select');
    },
    [regions, persistRegions]
  );

  const copyRegion = useCallback(
    (id: string) => {
      const src = regions.find((r) => r.id === id);
      if (!src) return;
      const r: Region = {
        id: crypto.randomUUID(),
        idx: regions.length + 1,
        color: paletteColor(regions.length),
        bbox: clampBbox({ ...src.bbox, x1: src.bbox.x1 + 24, y1: src.bbox.y1 + 24, x2: src.bbox.x2 + 24, y2: src.bbox.y2 + 24 }),
        instruction: src.instruction,
        refTokens: [...src.refTokens],
      };
      persistRegions([...regions, r], 0);
      setSelectedId(r.id);
    },
    [regions, persistRegions, clampBbox]
  );

  const updateRegion = useCallback(
    (id: string, patch: Partial<Region>) => {
      persistRegions(
        regions.map((r) => (r.id === id ? { ...r, ...patch, bbox: patch.bbox ? clampBbox(patch.bbox) : r.bbox } : r))
      );
    },
    [regions, persistRegions, clampBbox]
  );

  const deleteRegion = useCallback(
    (id: string) => {
      const next = regions.filter((r) => r.id !== id).map((r, i) => ({ ...r, idx: i + 1 }));
      persistRegions(next, 0);
      setSelectedId((v) => (v === id ? null : v));
    },
    [regions, persistRegions]
  );

  const onGlobalChange = useCallback(
    (text: string) => {
      setSaved(false);
      if (globalTimer.current) window.clearTimeout(globalTimer.current);
      globalTimer.current = window.setTimeout(async () => {
        try {
          await api.patchJob(jobId, { global_instruction: text });
          setDetail((d) => (d ? { ...d, job: { ...d.job, globalInstruction: text } } : d));
          const p = await api.preview(jobId);
          setPreview(p);
          setSaved(true);
        } catch (e) {
          setSaved(true);
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      }, 700);
    },
    [jobId, toast]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'r' || e.key === 'R') setTool('rect');
      else if (e.key === 'e' || e.key === 'E') setTool('ellipse');
      else if (e.key === 'p' || e.key === 'P') setTool('polygon');
      else if (e.key === 'l' || e.key === 'L') setTool('lasso');
      else if (e.key === 'v' || e.key === 'V' || e.key === 'Escape') setTool('select');
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteRegion(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, deleteRegion]);

  const saveName = async () => {
    if (!detail) return;
    const name = nameDraft.trim();
    if (!name || name === detail.job.name) return;
    try {
      await api.patchJob(jobId, { name });
      setDetail((d) => (d ? { ...d, job: { ...d.job, name } } : d));
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const generate = async () => {
    setGenBusy(true);
    try {
      const r = await api.generate(jobId, {});
      toast(`已入队（Run ${r.seq}），进度见左侧任务栏`, 'success');
      void refreshJobs();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setGenBusy(false);
    }
  };

  if (!detail) return <div className="loading-page">加载中…</div>;
  const liveJob = jobs.find((j) => j.id === jobId);
  const liveStatus = liveJob?.status ?? detail.job.status;
  const latestResultId = liveJob?.lastRun?.status === 'done' ? liveJob.lastRun.id : detail.job.finalRunId;

  return (
    <div className="editor">
      <div className="editor-col editor-col-left">
        <MaterialsPanel jobId={jobId} character={detail.job.character} materials={detail.materials} onChanged={() => {
          void api.job(jobId).then((d) => {
            setDetail((prev) => prev ? { ...prev, materials: d.materials } : d);
            setPreview(d.preview);
          }).catch((e) => toast(e.message, 'error'));
        }} softLimit={settings?.materialSoftLimit ?? 4} />
      </div>

      <div className="editor-col">
        <div className="editor-toolbar">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'jobs' })}>
            ← 客单
          </button>
          <input
            className="input"
            style={{ width: 190, padding: '4px 8px' }}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            title="客单名"
          />
          <StatusBadge status={liveStatus} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            {saved ? '已保存' : '保存中…'}
          </span>
          <div className="spacer" />
          <button className={cls('tool-btn', tool === 'select' && 'active')} onClick={() => setTool('select')} title="快捷键 V">
            ⬚ 选择
          </button>
          <button className={cls('tool-btn', tool === 'rect' && 'active')} onClick={() => setTool('rect')} title="快捷键 R">
            ▭ 矩形框选
          </button>
          <button className={cls('tool-btn', tool === 'ellipse' && 'active')} onClick={() => setTool('ellipse')} title="快捷键 E">◯ 椭圆</button>
          <button className={cls('tool-btn', tool === 'polygon' && 'active')} onClick={() => setTool('polygon')} title="快捷键 P">⬡ 多边形</button>
          <button className={cls('tool-btn', tool === 'lasso' && 'active')} onClick={() => setTool('lasso')} title="快捷键 L">⌁ 自由套索</button>
          <span className="toolbar-sep" />
          <button className="tool-btn" disabled={!selectedId} onClick={() => selectedId && deleteRegion(selectedId)}>
            删除所选
          </button>
          <div className="spacer" />
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          {(liveStatus === 'review' || liveStatus === 'delivered') && (
            <ResultLocationButton runId={latestResultId} className="btn btn-sm" />
          )}
          {(liveStatus === 'review' || liveStatus === 'delivered') && (
            <button className="btn btn-sm btn-primary" onClick={() => navigate({ name: 'review', jobId })}>
              进入审核 →
            </button>
          )}
        </div>
        <GenerationStatus jobId={jobId} />
        <AnnotationCanvas
          imageUrl={detail.job.originalUrl}
          regions={regions}
          selectedId={selectedId}
          tool={tool}
          onSelect={setSelectedId}
          onCreate={addRegion}
          onUpdate={(id, bbox) => updateRegion(id, { bbox })}
          onDelete={deleteRegion}
          onCopy={copyRegion}
          onScale={setZoom}
        />
      </div>

      <div className="editor-col editor-col-right">
        <PromptPanel
          job={{ ...detail.job, status: liveStatus }}
          materials={detail.materials}
          regions={regions}
          preview={preview}
          settings={settings}
          onGlobalChange={onGlobalChange}
          onUpdateRegion={updateRegion}
          onDeleteRegion={deleteRegion}
          onGenerate={() => void generate()}
          genBusy={genBusy}
        />
      </div>
    </div>
  );
}
