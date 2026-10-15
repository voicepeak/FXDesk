import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Modal from './Modal';
import RefSearchModal from './RefSearchModal';
import LibraryPicker from './LibraryPicker';
import { cls } from '../util';
import type { AnalysisResult, EffectKind, JobDetail, Material, MaterialRole, PrepData, PrepEffect } from '../types';

const ROLE_OPTIONS: { value: MaterialRole; label: string }[] = [
  { value: 'general', label: '综合参考' },
  { value: 'analysis', label: '角色补充参考' },
  { value: 'style', label: '特效风格参照' },
  { value: 'item', label: '物品参照' },
  { value: 'effect', label: '特效素材' },
];

const KIND_LABELS: Record<EffectKind, string> = { light: '光效', prop: '物品', background: '背景', other: '其他' };

const STATUS_LABELS: Record<PrepEffect['status'], string> = {
  ready: '待生成',
  queued: '排队中',
  generating: '生成中',
  review: '待确认',
  failed: '失败',
  approved: '已入库',
};

function statusChipClass(status: PrepEffect['status']): string {
  if (status === 'approved') return 'chip-green';
  if (status === 'review') return 'chip-blue';
  if (status === 'failed') return 'chip-red';
  if (status === 'queued' || status === 'generating') return 'chip-amber';
  return '';
}

interface Props {
  jobId: string;
  onClose: () => void;
  onChanged: () => void;
}

export default function PrepModal({ jobId, onClose, onChanged }: Props) {
  const { toast, settings, prepVersion, prepStage } = useStore();
  const [prep, setPrep] = useState<PrepData | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRefSearch, setShowRefSearch] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [briefDraft, setBriefDraft] = useState<string | null>(null);
  const briefTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api.prep(jobId), api.job(jobId)]);
      setPrep(p);
      setDetail(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (prepVersion > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepVersion]);

  const materials = detail?.materials ?? [];
  const brief = briefDraft ?? detail?.job.brief ?? '';

  const saveBrief = useCallback(
    (text: string) => {
      setBriefDraft(text);
      if (briefTimer.current) window.clearTimeout(briefTimer.current);
      briefTimer.current = window.setTimeout(async () => {
        try {
          await api.patchJob(jobId, { brief: text });
          setDetail((d) => (d ? { ...d, job: { ...d.job, brief: text } } : d));
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      }, 600);
    },
    [jobId, toast]
  );

  const doAnalyze = async () => {
    setBusy('analyze');
    try {
      await api.prepAnalyze(jobId);
      toast('已开始识别，请稍候…', 'info');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const doPropose = async () => {
    setBusy('propose');
    try {
      await api.prepPropose(jobId);
      toast('正在生成特效见解，请稍候…', 'info');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const addManualEffect = async () => {
    setBusy('add-effect');
    try {
      await api.prepAddEffect(jobId, { title: '新特效' });
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  const analysis = prep?.prep.analysis ?? null;
  const proposal = prep?.prep.proposal ?? null;
  const effects = useMemo(() => [...(prep?.effects ?? [])].sort((a, b) => a.seq - b.seq), [prep]);
  const refSearchKeyword = analysis?.result?.character || detail?.job.character || '';

  return (
    <Modal title="AI 筹备 · 识别 → 参考 → 见解 → 特效" onClose={onClose} width={980}>
      <div className="prep-body">
        {/* 步骤 1：识别分析 */}
        <section className="prep-section">
          <div className="prep-step-head">
            <span className="prep-step-no">1</span>
            角色识别
            <div className="spacer" />
            {analysis?.status === 'running' && <span className="chip chip-mini chip-amber">识别中…</span>}
            {analysis?.status === 'done' && <span className="chip chip-mini chip-green">已完成</span>}
            {analysis?.status === 'failed' && <span className="chip chip-mini chip-red">失败</span>}
          </div>
          {analysis?.status === 'failed' && analysis.error && <div className="refsearch-error">{analysis.error}</div>}
          {analysis?.status === 'running' && (
            <div className="form-hint" style={{ marginBottom: 8 }}>
              <strong>{prepStage && prepStage.jobId === jobId && prepStage.kind === 'analysis' ? prepStage.stage : '识别执行中…'}</strong>
              （后台执行，不抢屏）可以先关掉这个窗口去做其他客单，完成后会弹出提示，再回来确认即可。
            </div>
          )}
          <AnalysisForm
            key={`analysis-${analysis?.finishedAt ?? 0}-${analysis?.confirmedAt ?? 0}`}
            result={analysis?.result ?? null}
            busy={busy === 'analyze'}
            onAnalyze={() => void doAnalyze()}
            onSave={async (next) => {
              try {
                await api.prepSaveAnalysis(jobId, next);
                toast('识别结果已确认', 'success');
                refreshAll();
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'error');
              }
            }}
          />
        </section>

        {/* 步骤 2：参考与要求 */}
        <section className="prep-section">
          <div className="prep-step-head">
            <span className="prep-step-no">2</span>
            参考图与要求
            <div className="spacer" />
            <span className="muted" style={{ fontSize: 11.5 }}>顺序即参考图编号</span>
          </div>
          <div className="form-row">
            <label className="label">客户要求（会注入特效见解）</label>
            <textarea
              className="textarea"
              rows={2}
              placeholder="例：想在手中加一把剑，背景换成雨夜街道；不要太夸张，保持真实质感"
              value={brief}
              onChange={(e) => saveBrief(e.target.value)}
            />
          </div>
          <div className="form-hint" style={{ marginBottom: 8 }}>
            工作室要求（设置页「AI 筹备」）：{settings?.prepHouseRules?.trim() || '（未填写，可到设置页补充，如「保持真实光影、不要过饱和」）'}
          </div>
          <div className="prep-refs">
            {materials.map((m) => (
              <div className="prep-ref-row" key={m.id}>
                {m.fileUrl ? <img src={m.fileUrl} alt="" /> : <div className="prep-ref-thumb-empty" />}
                <span className="prep-ref-no">参考图{m.orderIndex}</span>
                <span className="prep-ref-name" title={m.displayName}>{m.displayName}</span>
                {m.blendPrompt && <span className="chip chip-mini chip-violet" title={m.blendPrompt}>含融入说明</span>}
                <select
                  className="select prep-role-select"
                  value={m.role}
                  onChange={async (e) => {
                    try {
                      await api.setMaterialRole(jobId, m.id, e.target.value);
                      refreshAll();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err), 'error');
                    }
                  }}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            ))}
            {materials.length === 0 && <div className="empty-hint">还没有参考图。可上传客户图片，或用「网络搜参考」从人工挑选的小红书图片中加入。</div>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-sm" onClick={() => setShowRefSearch(true)}>网络搜参考</button>
            <button className="btn btn-sm" onClick={() => setShowLibrary(true)}>从素材库选择</button>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              ＋ 上传参考图
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.avif"
                multiple
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  for (const f of files) {
                    try {
                      await api.addMaterialFile(jobId, f);
                    } catch (err) {
                      toast(`${f.name}：${err instanceof Error ? err.message : String(err)}`, 'error');
                    }
                  }
                  refreshAll();
                }}
              />
            </label>
          </div>
        </section>

        {/* 步骤 3：特效见解 */}
        <section className="prep-section">
          <div className="prep-step-head">
            <span className="prep-step-no">3</span>
            特效见解与预演图
            <div className="spacer" />
            {proposal?.status === 'running' && <span className="chip chip-mini chip-amber">生成中…</span>}
            {proposal?.status === 'failed' && <span className="chip chip-mini chip-red">失败</span>}
          </div>
          {proposal?.status === 'failed' && proposal.error && <div className="refsearch-error">{proposal.error}</div>}
          {proposal?.status === 'running' && (
            <div className="form-hint" style={{ marginBottom: 8 }}>
              <strong>{prepStage && prepStage.jobId === jobId && prepStage.kind === 'proposal' ? prepStage.stage : '特效见解生成中…'}</strong>
            </div>
          )}
          {(!effects.length || proposal?.status === 'failed') && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button className="btn btn-primary btn-sm" disabled={!analysis?.result || busy === 'propose' || proposal?.status === 'running'} onClick={() => void doPropose()}>
                {proposal?.status === 'running' ? '生成中…' : proposal?.status === 'failed' || effects.length ? '重新生成特效见解' : '生成特效见解'}
              </button>
              {!analysis?.result && <span className="muted" style={{ fontSize: 11.5 }}>请先完成步骤 1 的角色识别</span>}
            </div>
          )}

          {effects.map((e) => (
            <EffectCard
              key={e.id}
              jobId={jobId}
              effect={e}
              materials={materials}
              onChanged={refreshAll}
            />
          ))}

          {effects.some((e) => e.status === 'queued' || e.status === 'generating') && (
            <div className="form-hint" style={{ marginBottom: 8 }}>特效预演在任务队列中执行：可关闭本窗口，进度见左侧任务栏，完成后会弹出提示。</div>
          )}

          <button className="btn btn-sm" disabled={busy === 'add-effect'} onClick={() => void addManualEffect()}>
            ＋ 手动添加特效
          </button>
        </section>

        <div className="form-hint">
          预演图为 1K 级效果草图（后续交付合成会超分到原图分辨率）。确认通过后会：① 入库为「特效」素材（携带生成描述与融入说明）② 自动加为当前客单参考图；在编辑器中引用它时，整体提示词会自动附带融入说明，防止歧义。
        </div>
      </div>

      {showRefSearch && (
        <RefSearchModal
          jobId={jobId}
          initialKeyword={refSearchKeyword}
          onClose={() => setShowRefSearch(false)}
          onImported={refreshAll}
        />
      )}
      {showLibrary && (
        <LibraryPicker
          onClose={() => setShowLibrary(false)}
          onPick={async (item) => {
            setShowLibrary(false);
            try {
              await api.addMaterialLibrary(jobId, item.id, item.title, item.type === 'effect' ? 'effect' : 'general');
              refreshAll();
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error');
            }
          }}
        />
      )}
    </Modal>
  );
}

function AnalysisForm(props: {
  result: AnalysisResult | null;
  busy: boolean;
  onAnalyze: () => void;
  onSave: (next: Partial<AnalysisResult>) => Promise<void>;
}) {
  const r = props.result;
  const [character, setCharacter] = useState(r?.character ?? '');
  const [work, setWork] = useState(r?.work ?? '');
  const [aliases, setAliases] = useState((r?.aliases ?? []).join('、'));
  const [scene, setScene] = useState(r?.scene ?? '');
  const [notes, setNotes] = useState(r?.notes ?? '');
  const [saving, setSaving] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <button className="btn btn-sm" disabled={props.busy} onClick={props.onAnalyze}>
          {props.busy ? '识别中…' : r ? '重新识别' : '开始识别'}
        </button>
        {r && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            置信度 {r.confidence != null ? Math.round(r.confidence * 100) + '%' : '—'}
          </span>
        )}
      </div>
      <div className="form-hint" style={{ marginBottom: 8 }}>
        识别会自动把「参考图」一并发给豆包（非特效素材，最多 4 张）：建议先在步骤 2 放好参考图再点识别；之后补图可点「重新识别」。
      </div>
      {r && (
        <div className="prep-analysis-grid">
          <div className="form-row">
            <label className="label">角色名</label>
            <input className="input" value={character} onChange={(e) => setCharacter(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="label">作品</label>
            <input className="input" value={work} onChange={(e) => setWork(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="label">别称（顿号分隔）</label>
            <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} />
          </div>
          <div className="form-row" style={{ gridColumn: '1 / -1' }}>
            <label className="label">场景描述</label>
            <textarea className="textarea" rows={2} value={scene} onChange={(e) => setScene(e.target.value)} />
          </div>
          {(notes || r.notes) && (
            <div className="form-row" style={{ gridColumn: '1 / -1' }}>
              <label className="label">备注</label>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          )}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                await props.onSave({
                  character,
                  work,
                  aliases: aliases.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean),
                  scene,
                  notes,
                });
                setSaving(false);
              }}
            >
              {saving ? '保存中…' : '保存并确认'}
            </button>
            <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>
              确认后角色名会同步到客单（用于搜索关键词与归档标签）
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function EffectCard(props: { jobId: string; effect: PrepEffect; materials: Material[]; onChanged: () => void }) {
  const { toast } = useStore();
  const e = props.effect;
  const [title, setTitle] = useState(e.title);
  const [genPrompt, setGenPrompt] = useState(e.genPrompt);
  const [blendPrompt, setBlendPrompt] = useState(e.blendPrompt);
  const [busy, setBusy] = useState<string | null>(null);
  const [imported, setImported] = useState<{ refNo: number } | null>(null);
  const editable = !['approved'].includes(e.status);

  useEffect(() => {
    setTitle(e.title);
    setGenPrompt(e.genPrompt);
    setBlendPrompt(e.blendPrompt);
  }, [e.id, e.title, e.genPrompt, e.blendPrompt]);

  const saveIfChanged = async () => {
    if (!editable) return;
    if (title === e.title && genPrompt === e.genPrompt && blendPrompt === e.blendPrompt) return;
    try {
      await api.prepUpdateEffect(props.jobId, e.id, { title, genPrompt, blendPrompt });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const toggleRef = async (mid: string) => {
    if (!editable) return;
    const next = e.refMaterialIds.includes(mid) ? e.refMaterialIds.filter((x) => x !== mid) : [...e.refMaterialIds, mid];
    try {
      await api.prepUpdateEffect(props.jobId, e.id, { refMaterialIds: next });
      props.onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const generate = async () => {
    setBusy('generate');
    try {
      await saveIfChanged();
      await api.prepGenerateEffect(props.jobId, e.id);
      toast('特效预演已入队（1K 草图），可在任务栏查看进度', 'info');
      props.onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setBusy('approve');
    try {
      const r = await api.prepApproveEffect(props.jobId, e.id);
      setImported({ refNo: r.refNo });
      toast(`已入库并加为参考图${r.refNo}（含融入说明）`, 'success');
      props.onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (!window.confirm(`删除特效「${e.title}」？`)) return;
    try {
      await api.prepDeleteEffect(props.jobId, e.id);
      props.onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const refMaterials = props.materials.filter((m) => m.role !== 'effect');

  return (
    <div className="prep-effect-card">
      <div className="prep-effect-head">
        <span className="prep-effect-no">#{e.seq}</span>
        <input
          className="input prep-effect-title"
          value={title}
          disabled={!editable}
          onChange={(ev) => setTitle(ev.target.value)}
          onBlur={() => void saveIfChanged()}
        />
        <span className={cls('chip', 'chip-mini', statusChipClass(e.status))}>{STATUS_LABELS[e.status]}</span>
        {e.kind && <span className="chip chip-mini">{KIND_LABELS[e.kind]}</span>}
        <div className="spacer" />
        {editable && (
          <button className="icon-btn" title="删除该特效" onClick={() => void del()}>
            🗑
          </button>
        )}
      </div>
      <div className="prep-effect-body">
        <div className="prep-effect-fields">
          <div className="form-row">
            <label className="label">生成描述（给特效模型，1K 预演草图）</label>
            <textarea
              className="textarea"
              rows={3}
              value={genPrompt}
              disabled={!editable}
              onChange={(ev) => setGenPrompt(ev.target.value)}
              onBlur={() => void saveIfChanged()}
              placeholder="描述特效形态、位置、角度、光色与受光方向…"
            />
          </div>
          <div className="form-row">
            <label className="label">融入描述（合成时自动注入整体提示词）</label>
            <textarea
              className="textarea"
              rows={3}
              value={blendPrompt}
              disabled={!editable}
              onChange={(ev) => setBlendPrompt(ev.target.value)}
              onBlur={() => void saveIfChanged()}
              placeholder="例：本特效在人物身后环绕，人物位于前景遮挡中段光弧；亮度不压过面部…"
            />
          </div>
          {refMaterials.length > 0 && (
            <div className="form-row">
              <label className="label">生成用参考图</label>
              <div className="prep-ref-toggles">
                {refMaterials.map((m) => (
                  <label key={m.id} className={cls('prep-ref-toggle', e.refMaterialIds.includes(m.id) && 'on')}>
                    <input
                      type="checkbox"
                      checked={e.refMaterialIds.includes(m.id)}
                      disabled={!editable}
                      onChange={() => void toggleRef(m.id)}
                    />
                    参考图{m.orderIndex}·{m.displayName}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="prep-effect-actions">
            <button
              className="btn btn-sm btn-primary"
              disabled={!editable || busy === 'generate' || e.status === 'queued' || e.status === 'generating' || !genPrompt.trim()}
              onClick={() => void generate()}
            >
              {e.status === 'queued' || e.status === 'generating' ? '生成中…' : e.imageUrl ? '重新生成' : '生成特效图'}
            </button>
            {e.status === 'review' && (
              <button className="btn btn-sm" disabled={busy === 'approve'} onClick={() => void approve()}>
                {busy === 'approve' ? '入库中…' : '通过并入库'}
              </button>
            )}
            {e.status === 'approved' && <span className="muted" style={{ fontSize: 11.5 }}>已入库{imported ? `（参考图${imported.refNo}）` : ''}</span>}
            {e.error && e.status === 'failed' && <span className="refsearch-error" style={{ margin: 0 }}>{e.error}</span>}
          </div>
        </div>
        <div className="prep-effect-image">
          {e.imageUrl ? (
            <img src={e.imageUrl} alt="" />
          ) : (
            <div className="prep-effect-image-empty">{e.status === 'generating' || e.status === 'queued' ? '生成中…' : '暂无预演图'}</div>
          )}
          {e.status === 'review' && <div className="prep-effect-hint">确认效果后再「通过并入库」</div>}
        </div>
      </div>
    </div>
  );
}
