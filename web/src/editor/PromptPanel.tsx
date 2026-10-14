import { useMemo, useState } from 'react';
import { cls, colorName, fmtCost } from '../util';
import type { JobDetail, Material, Region, Settings } from '../types';

interface Props {
  job: JobDetail['job'];
  materials: Material[];
  regions: Region[];
  preview: JobDetail['preview'] | null;
  settings: Settings | null;
  onGlobalChange: (text: string) => void;
  onUpdateRegion: (id: string, patch: Partial<Region>) => void;
  onDeleteRegion: (id: string) => void;
  onGenerate: () => void;
  genBusy: boolean;
}

export default function PromptPanel(props: Props) {
  const [showFinal, setShowFinal] = useState(false);
  const [globalDraft, setGlobalDraft] = useState<string | null>(null);

  const globalText = globalDraft ?? props.job.globalInstruction;

  const locationOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of props.preview?.regionLines ?? []) map.set(l.regionId, l.line);
    return map;
  }, [props.preview]);

  const blocks = props.preview?.blocks ?? [];
  const systemBlock = blocks.find((b) => b.kind === 'system');
  const globalBlock = blocks.find((b) => b.kind === 'global');
  const endingBlock = blocks.find((b) => b.kind === 'ending');

  const activeStatuses = ['queued', 'generating', 'qc', 'repairing'];
  const genReason = (() => {
    if (activeStatuses.includes(props.job.status)) return '当前有进行中的任务，完成后可再次生成';
    if (props.settings && !props.settings.mockApi && !props.settings.apiKey) return '未配置 API Key，请到设置页填写';
    if (props.regions.some((r) => !r.instruction.trim())) return '存在指令为空的区域（已标红），请填写后再生成';
    return null;
  })();

  const insertRef = (regionId: string, materialId: string) => {
    const m = props.materials.find((x) => x.id === materialId);
    const r = props.regions.find((x) => x.id === regionId);
    if (!m || !r) return;
    const token = { materialId: m.id, refNo: m.orderIndex, name: m.displayName };
    const sep = r.instruction && !r.instruction.endsWith(' ') ? '，' : '';
    props.onUpdateRegion(regionId, {
      instruction: `${r.instruction}${sep}参考图${m.orderIndex}`,
      refTokens: [...r.refTokens.filter((t) => t.materialId !== m.id), token],
    });
  };

  return (
    <>
      <div className="panel-head">
        提示词总览
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowFinal((v) => !v)}>
          {showFinal ? '收起全文' : '查看最终提示词'}
        </button>
      </div>
      <div className="panel-scroll">
        <details className="prompt-block prompt-readonly">
          <summary className="prompt-block-head">
            系统约束
            <div className="spacer" />
            <span className="chip chip-mini">只读</span>
          </summary>
          <div className="prompt-block-body">
            <div className="prompt-locked">{systemBlock?.text ?? ''}</div>
          </div>
        </details>

        {props.regions.map((r) => {
          const cname = colorName(r.color);
          return (
            <div className="prompt-block" key={r.id} style={{ borderColor: props.regions.length && !r.instruction.trim() ? 'rgba(229,72,77,0.55)' : undefined }}>
              <div className="prompt-block-head">
                <span className="region-color-dot" style={{ background: r.color }} />
                {cname}框 第{r.idx}区
                <div className="spacer" />
                <button className="icon-btn" title="删除区域" onClick={() => props.onDeleteRegion(r.id)}>
                  🗑
                </button>
              </div>
              <div className="prompt-block-body">
                <div className="region-location">{locationOf.get(r.id)?.replace(/^【[^】]*】位置：/, '') ?? '位置计算中…'}</div>
                <textarea
                  className="textarea"
                  placeholder={`例：在手中添加参考图1的剑，握持关系自然，剑身受光与环境光一致`}
                  value={r.instruction}
                  onChange={(e) => props.onUpdateRegion(r.id, { instruction: e.target.value })}
                  rows={2}
                />
                <div className="ref-chip-row">
                  <select
                    className="select"
                    style={{ width: 150, padding: '4px 8px', fontSize: 12 }}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) insertRef(r.id, e.target.value);
                      e.target.value = '';
                    }}
                  >
                    <option value="">＋ 插入参考图</option>
                    {props.materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        参考图{m.orderIndex}：{m.displayName}
                      </option>
                    ))}
                  </select>
                  {r.refTokens.map((t) => (
                    <span className="chip chip-blue" key={t.materialId}>
                      参考图{t.refNo}·{t.name}
                      <button
                        className="icon-btn"
                        style={{ width: 16, height: 16, fontSize: 10 }}
                        title="移除引用标记"
                        onClick={() => props.onUpdateRegion(r.id, { refTokens: r.refTokens.filter((x) => x.materialId !== t.materialId) })}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                {!r.instruction.trim() && <div className="gen-reason">指令为空：生成前必须填写</div>}
              </div>
            </div>
          );
        })}

        {props.regions.length > 5 && (
          <div className="gen-reason" style={{ margin: '0 12px' }}>
            ⚠ 区域较多可能降低指令准确率，建议拆分两次生成
          </div>
        )}

        <div className="prompt-block">
          <div className="prompt-block-head">全局指令</div>
          <div className="prompt-block-body">
            <textarea
              className="textarea"
              rows={3}
              placeholder="例：将背景整体替换为雨夜赛博朋克街道，霓虹反光与人物轮廓光方向一致"
              value={globalText}
              onChange={(e) => {
                setGlobalDraft(e.target.value);
                props.onGlobalChange(e.target.value);
              }}
            />
            {!globalBlock && <div className="region-location" style={{ marginTop: 6 }}>留空则省略全局修改</div>}
          </div>
        </div>

        <details className="prompt-block prompt-readonly">
          <summary className="prompt-block-head">
            融合与标记移除
            <div className="spacer" />
            <span className="chip chip-mini">只读</span>
          </summary>
          <div className="prompt-block-body">
            <div className="prompt-locked">{endingBlock?.text ?? ''}</div>
          </div>
        </details>

        {showFinal && (
          <div className="prompt-block">
            <div className="prompt-block-head">最终提示词全文（只读复核）</div>
            <div className="prompt-block-body">
              <div className="final-prompt">{props.preview?.finalPrompt ?? '（原图缺失，无法预览）'}</div>
            </div>
          </div>
        )}
      </div>

      <div className="gen-bar">
        <button className="btn btn-primary gen-btn" disabled={!!genReason || props.genBusy} onClick={props.onGenerate}>
          {props.genBusy ? '提交中…' : '开始生成'}
        </button>
        <div className="region-location" style={{ marginTop: 7 }}>
          单张费用 {fmtCost(props.settings?.pricePerImage ?? 0)} · 累计 {fmtCost(props.job.costTotal)}
        </div>
        {genReason && <div className="gen-reason">{genReason}</div>}
      </div>
    </>
  );
}
