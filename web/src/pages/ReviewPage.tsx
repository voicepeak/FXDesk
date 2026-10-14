import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from '../components/Modal';
import ResultLocationButton from '../components/ResultLocationButton';
import GenerationStatus from '../components/GenerationStatus';
import { StatusBadge } from './JobsPage';
import { cls, fmtCost, fmtDuration, paletteColor } from '../util';
import type { Bbox, JobDetail, Run } from '../types';

interface RepairRect {
  id: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  instruction: string;
}

const ACTIVE_STATUSES = ['queued', 'generating', 'qc', 'repairing'];

export default function ReviewPage({ jobId }: { jobId: string }) {
  const { navigate, toast, refreshJobs } = useStore();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [baseDims, setBaseDims] = useState<{ w: number; h: number } | null>(null);
  const [resultDims, setResultDims] = useState<{ w: number; h: number } | null>(null);
  const [wipe, setWipe] = useState(false);
  const [wipePos, setWipePos] = useState(50);
  const [repairMode, setRepairMode] = useState(false);
  const [repairRects, setRepairRects] = useState<RepairRect[]>([]);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [elements, setElements] = useState<{ label: string; checked: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ active: boolean; sx: number; sy: number; tx: number; ty: number }>({ active: false, sx: 0, sy: 0, tx: 0, ty: 0 });

  const load = useCallback(async () => {
    try {
      const d = await api.job(jobId);
      setDetail(d);
      setCurrentRunId((cur) => {
        if (cur && d.runs.some((r) => r.id === cur)) return cur;
        return d.job.finalRunId ?? [...d.runs].reverse().find((r) => r.resultUrl)?.id ?? null;
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      navigate({ name: 'jobs' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const currentRun: Run | null = useMemo(() => detail?.runs.find((r) => r.id === currentRunId) ?? null, [detail, currentRunId]);

  useEffect(() => {
    setElements(currentRun?.qc?.elements?.confirmed ?? []);
    setRepairRects([]);
    setRepairMode(false);
    if (currentRun?.resultUrl) {
      const im = new window.Image();
      im.onload = () => setResultDims({ w: im.naturalWidth, h: im.naturalHeight });
      im.src = currentRun.resultUrl;
    } else {
      setResultDims(null);
    }
  }, [currentRun?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = useCallback(() => {
    const el = leftPaneRef.current;
    if (!el || !baseDims) return;
    const s = Math.min((el.clientWidth - 20) / baseDims.w, (el.clientHeight - 20) / baseDims.h);
    setTransform({ scale: s, tx: (el.clientWidth - baseDims.w * s) / 2, ty: (el.clientHeight - baseDims.h * s) / 2 });
  }, [baseDims]);

  useEffect(() => {
    if (baseDims && !wipe) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDims, wipe]);

  const onWheel = (e: React.WheelEvent) => {
    if (wipe || repairMode) return;
    e.preventDefault();
    const el = leftPaneRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setTransform((t) => {
      const ns = Math.max(0.05, Math.min(8, t.scale * (e.deltaY > 0 ? 1 / 1.08 : 1.08)));
      const k = ns / t.scale;
      return { scale: ns, tx: px - (px - t.tx) * k, ty: py - (py - t.ty) * k };
    });
  };

  const onPanStart = (e: React.MouseEvent) => {
    if (wipe || repairMode || e.button !== 0) return;
    pan.current = { active: true, sx: e.clientX, sy: e.clientY, tx: transform.tx, ty: transform.ty };
  };
  const onPanMove = (e: React.MouseEvent) => {
    if (!pan.current.active) return;
    setTransform((t) => ({ ...t, tx: pan.current.tx + (e.clientX - pan.current.sx), ty: pan.current.ty + (e.clientY - pan.current.sy) }));
  };
  const onPanEnd = () => {
    pan.current.active = false;
  };

  const imgStyle: React.CSSProperties = {
    transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
    width: baseDims?.w,
    height: baseDims?.h,
  };

  /* ---------- repair overlay ---------- */
  const relPos = (e: React.MouseEvent): { x: number; y: number } => {
    const el = rightPaneRef.current!;
    const rect = el.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };
  const onRepairDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = relPos(e);
    setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onRepairMove = (e: React.MouseEvent) => {
    if (!drawing) return;
    const p = relPos(e);
    setDrawing({ ...drawing, x1: p.x, y1: p.y });
  };
  const onRepairUp = () => {
    if (!drawing) return;
    const x = Math.min(drawing.x0, drawing.x1);
    const y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    setDrawing(null);
    if (w < 0.02 || h < 0.02) return;
    setRepairRects((rs) => [
      ...rs,
      { id: crypto.randomUUID(), color: paletteColor(rs.length), x, y, w, h, instruction: '' },
    ]);
  };

  const toResultBbox = (r: RepairRect): Bbox => {
    const dims = resultDims ?? baseDims;
    if (!dims) return { x1: 0, y1: 0, x2: 0, y2: 0 };
    return { x1: r.x * dims.w, y1: r.y * dims.h, x2: (r.x + r.w) * dims.w, y2: (r.y + r.h) * dims.h };
  };

  /* ---------- actions ---------- */
  const deliver = async () => {
    if (!currentRun) return;
    if (!window.confirm('通过交付并自动归档到素材库历史成果？')) return;
    setBusy(true);
    try {
      const r = await api.deliver(jobId, currentRun.id);
      toast(`已交付并归档（标签：${r.tags.join('、')}）`, 'success');
      void refreshJobs();
      navigate({ name: 'jobs' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rerun = async () => {
    if (!currentRun) return;
    setBusy(true);
    try {
      const r = await api.generate(jobId, { type: 'rerun', baseRunId: currentRun.id });
      toast(`已重跑入队（Run ${r.seq}）`, 'success');
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitRepair = async () => {
    if (!currentRun) return;
    if (repairRects.some((r) => !r.instruction.trim())) {
      toast('每个问题区都需要填写修复指令', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.repair(
        jobId,
        currentRun.id,
        repairRects.map((rr) => ({ color: rr.color, bbox: toResultBbox(rr), instruction: rr.instruction }))
      );
      toast(`定点重修已入队（Run ${r.seq}）`, 'success');
      setRepairRects([]);
      setRepairMode(false);
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!currentRun) return;
    try {
      await api.cancelRun(currentRun.id);
      toast(currentRun.status === 'queued' ? '已取消排队' : '已停止本地等待；远端可能仍在处理，请核对记录');
      void load();
      void refreshJobs();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const saveNote = async () => {
    if (!currentRun) return;
    try {
      await api.saveReview(currentRun.id, 'note', note);
      toast('备注已保存');
      setNoteOpen(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const toggleElement = (i: number) => {
    const next = elements.map((e, j) => (j === i ? { ...e, checked: !e.checked } : e));
    setElements(next);
    if (currentRun) void api.saveElements(currentRun.id, next).catch(() => undefined);
  };

  if (!detail) return <div className="loading-page">加载中…</div>;

  const qc = currentRun?.qc ?? null;
  const identity = qc?.identity;
  const composition = qc?.composition;
  const runActive = !!currentRun && ACTIVE_STATUSES.includes(currentRun.status);

  const identityView = (() => {
    if (!identity) return { cls: 'qc-skip', text: '身份检测：无数据' };
    if (identity.status === 'pass') return { cls: 'qc-ok', text: `身份相似度 ${identity.sim?.toFixed(3)} · 通过` };
    if (identity.status === 'mid')
      return {
        cls: 'qc-warn',
        text: `身份 ${identity.sim?.toFixed(3)} · 中分${identity.afterRepair ? `（已自动面部重修，修复后 ${identity.afterRepair.sim != null ? identity.afterRepair.sim.toFixed(3) : identity.afterRepair.status}）` : '（自动面部重修未执行）'}`,
      };
    if (identity.status === 'fail') return { cls: 'qc-bad', text: `身份相似度 ${identity.sim?.toFixed(3)} · 不达标，请人工处理` };
    if (identity.reason === 'model_missing') return { cls: 'qc-skip', text: '身份检测未启用（QC 模型未安装），请目检' };
    if (identity.reason === 'no_face') return { cls: 'qc-skip', text: '身份：未检测到人脸（侧脸/遮挡），请目检' };
    return { cls: 'qc-skip', text: '身份：检测跳过，请目检' };
  })();

  const compositionView = composition
    ? composition.verdict === 'ok'
      ? { cls: 'qc-ok', text: `构图一致（SSIM ${composition.ssim}，pHash ${composition.phashDistance}）` }
      : { cls: 'qc-warn', text: `⚠ 构图可能偏移，请目检（SSIM ${composition.ssim}，pHash ${composition.phashDistance}）` }
    : { cls: 'qc-skip', text: '构图检测无数据' };

  return (
    <div className="review">
      <div className="review-banner">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'editor', jobId })}>
          ← 编辑
        </button>
        <span style={{ fontWeight: 700 }}>{detail.job.name}</span>
        <StatusBadge status={detail.job.status} />
        <span className={cls('qc-item', identityView.cls)}>◉ {identityView.text}</span>
        <span className={cls('qc-item', compositionView.cls)}>◫ {compositionView.text}</span>
        {qc?.faceRepair?.triggered && (
          <span className={cls('qc-item', qc.faceRepair.status === 'done' ? 'qc-ok' : 'qc-bad')}>
            ⚕ 面部重修{qc.faceRepair.status === 'done' ? '已完成' : qc.faceRepair.status === 'failed' ? '失败（转人工）' : '进行中'}
          </span>
        )}
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setWipe((w) => !w)}>
          {wipe ? '退出滑块对比' : '滑块对比'}
        </button>
        <button className="btn btn-sm" onClick={() => { setWipe(false); fit(); }}>
          适配窗口
        </button>
        <button
          className="btn btn-sm"
          onClick={() => {
            setWipe(false);
            const el = leftPaneRef.current;
            if (!el || !baseDims) return;
            setTransform({ scale: 1, tx: (el.clientWidth - baseDims.w) / 2, ty: (el.clientHeight - baseDims.h) / 2 });
          }}
        >
          1:1
        </button>
      </div>

      <GenerationStatus jobId={jobId} />
      <div className="review-main">
        {wipe ? (
          <div className="wipe-pane" style={{ gridColumn: '1 / 3' }}>
            <span className="pane-label">原图（左） / 结果（右，拖动下方滑块）</span>
            <img className="wipe-img" src={detail.job.originalUrl} style={{ width: '100%', height: '100%', objectFit: 'contain' }} alt="" />
            <img
              className="wipe-img"
              src={currentRun?.resultUrl ?? detail.job.originalUrl}
              style={{ width: '100%', height: '100%', objectFit: 'contain', clipPath: `inset(0 0 0 ${wipePos}%)` }}
              alt=""
            />
            <input type="range" className="wipe-slider" min={0} max={100} value={wipePos} onChange={(e) => setWipePos(Number(e.target.value))} />
          </div>
        ) : (
          <>
            <div
              className="compare-pane"
              ref={leftPaneRef}
              onWheel={onWheel}
              onMouseDown={onPanStart}
              onMouseMove={onPanMove}
              onMouseUp={onPanEnd}
              onMouseLeave={onPanEnd}
            >
              <span className="pane-label">原图</span>
              <img
                className="compare-img"
                src={detail.job.originalUrl}
                style={{ ...imgStyle, width: undefined, height: undefined, transform: imgStyle.transform }}
                onLoad={(e) => {
                  const im = e.currentTarget;
                  setBaseDims({ w: im.naturalWidth, h: im.naturalHeight });
                }}
                draggable={false}
                alt=""
              />
            </div>
            <div
              className="compare-pane"
              ref={rightPaneRef}
              onWheel={onWheel}
              onMouseDown={(e) => {
                if (repairMode) onRepairDown(e);
                else onPanStart(e);
              }}
              onMouseMove={(e) => {
                if (repairMode) onRepairMove(e);
                else onPanMove(e);
              }}
              onMouseUp={() => {
                if (repairMode) onRepairUp();
                else onPanEnd();
              }}
              onMouseLeave={onPanEnd}
            >
              <span className="pane-label">
                结果{currentRun ? ` · Run ${currentRun.seq}（${currentRun.type}）` : ''}
                {currentRun?.elapsedMs != null && ` · ${fmtDuration(currentRun.elapsedMs)}`}
                {currentRun && ` · ${fmtCost(currentRun.cost)}`}
              </span>
              {currentRun?.resultUrl ? (
                <img className="compare-img" src={currentRun.resultUrl} style={imgStyle} draggable={false} alt="" />
              ) : (
                <div className="review-empty">{runActive ? '生成中…' : '该 Run 暂无结果图'}</div>
              )}
              {repairMode && (
                <div className="repair-overlay" onMouseDown={(e) => e.stopPropagation()} style={{ cursor: 'crosshair' }}>
                  <div style={{ position: 'absolute', inset: 0 }} onMouseDown={onRepairDown} onMouseMove={onRepairMove} onMouseUp={onRepairUp} />
                  {repairRects.map((r) => (
                    <div className="repair-rect" key={r.id} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: r.color }} />
                  ))}
                  {drawing && (
                    <div
                      className="repair-rect"
                      style={{
                        left: `${Math.min(drawing.x0, drawing.x1) * 100}%`,
                        top: `${Math.min(drawing.y0, drawing.y1) * 100}%`,
                        width: `${Math.abs(drawing.x1 - drawing.x0) * 100}%`,
                        height: `${Math.abs(drawing.y1 - drawing.y0) * 100}%`,
                        borderColor: '#4F8CFF',
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div className="review-side">
          <h4>操作</h4>
          <ResultLocationButton runId={currentRun?.id} disabled={!currentRun?.resultUrl} />
          <button
            className="btn btn-primary"
            disabled={!currentRun || busy || runActive || !currentRun.resultUrl || detail.job.status === 'delivered'}
            onClick={() => void deliver()}
          >
            ✓ 通过交付（当前 Run）
          </button>
          <button className="btn" disabled={!currentRun || busy || runActive} onClick={() => void rerun()}>
            ↻ 重跑（以当前配置）
          </button>
          <button className={cls('btn', repairMode && 'btn-primary')} disabled={!currentRun || busy || runActive || !currentRun.resultUrl} onClick={() => setRepairMode((v) => !v)}>
            {repairMode ? '退出定点重修' : '✎ 定点重修'}
          </button>
          {repairMode && (
            <div>
              <div className="form-hint">在右侧结果图上拖拽圈出问题区（每次生成前自动适配窗口）</div>
              {repairRects.map((r, i) => (
                <div className="prompt-block" key={r.id} style={{ marginTop: 8 }}>
                  <div className="prompt-block-head">
                    <span className="region-color-dot" style={{ background: r.color }} />
                    问题区 {i + 1}
                    <div className="spacer" />
                    <button className="icon-btn" onClick={() => setRepairRects((rs) => rs.filter((x) => x.id !== r.id))}>
                      ✕
                    </button>
                  </div>
                  <div className="prompt-block-body">
                    <textarea
                      className="textarea"
                      rows={2}
                      placeholder="例：该区域手部结构错误，参考原图手型修正手指结构，保持光影一致"
                      value={r.instruction}
                      onChange={(e) => setRepairRects((rs) => rs.map((x) => (x.id === r.id ? { ...x, instruction: e.target.value } : x)))}
                    />
                  </div>
                </div>
              ))}
              <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={!repairRects.length || busy} onClick={() => void submitRepair()}>
                提交重修（{repairRects.length} 个问题区）
              </button>
            </div>
          )}
          <button className="btn" disabled={!currentRun} onClick={() => setNoteOpen(true)}>
            备注
          </button>
          {runActive && (
            <button className="btn btn-danger" onClick={() => void cancelRun()}>
              取消当前任务
            </button>
          )}

          <h4>元素确认（人工）</h4>
          {elements.length === 0 && <div className="form-hint">无建议元素。区域指令中的名词会自动出现在这里。</div>}
          <div className="elements-list">
            {elements.map((e, i) => (
              <label className="element-row" key={e.label}>
                <input type="checkbox" checked={e.checked} onChange={() => toggleElement(i)} />
                {e.label}
                {e.checked && <span className="qc-ok">✓</span>}
              </label>
            ))}
          </div>

          <h4>Run 信息</h4>
          {currentRun && (
            <div>
              <div className="kv-row">
                <span>类型</span>
                <span className="kv-val">{currentRun.type}</span>
              </div>
              <div className="kv-row">
                <span>状态</span>
                <span className="kv-val">{currentRun.status}</span>
              </div>
              <div className="kv-row">
                <span>费用</span>
                <span className="kv-val">{fmtCost(currentRun.cost)}</span>
              </div>
              {currentRun.error && (
                <div className="kv-row">
                  <span>错误</span>
                  <span className="kv-val error-text">{currentRun.error}</span>
                </div>
              )}
              {currentRun.markerUrl && (
                <div className="form-hint">
                  <a href={currentRun.markerUrl} target="_blank" rel="noreferrer">
                    查看标记图（发给模型的输入）
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="run-strip">
        {detail.runs.map((r) => (
          <div key={r.id} className={cls('run-thumb-card', r.id === currentRunId && 'active')} onClick={() => setCurrentRunId(r.id)}>
            {r.resultUrl ? <img src={r.resultUrl} alt="" /> : <div style={{ height: 70, background: '#0b0d10' }} />}
            <div className="run-thumb-label">
              <span>v{r.seq}</span>
              <span className={cls('chip', 'chip-mini', r.type === 'faceRepair' ? 'chip-violet' : r.type === 'repair' ? 'chip-amber' : r.type === 'rerun' ? 'chip-blue' : '')}>
                {r.type === 'faceRepair' ? '重修' : r.type === 'repair' ? '定点' : r.type === 'rerun' ? '重跑' : '首跑'}
              </span>
            </div>
          </div>
        ))}
      </div>

      {noteOpen && (
        <Modal title="审核备注" onClose={() => setNoteOpen(false)}>
          <textarea className="textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="自由记录审核意见…" autoFocus />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => void saveNote()}>
              保存备注
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
