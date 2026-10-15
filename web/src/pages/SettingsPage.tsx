import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { fmtCost } from '../util';
import type { Settings } from '../types';

const PLACEHOLDER_HINTS: Partial<Record<keyof Settings, string>> = {
  tplRegion: '必须保留占位符：{{color}} {{n}} {{location}} {{instruction}}',
  tplGlobal: '必须保留占位符：{{globalInstruction}}',
  tplRepair: '必须保留占位符：{{color}} {{n}} {{location}} {{repairInstruction}}',
  tplPlate: '必须保留占位符：{{effectDescription}}',
  tplPropose: '必须保留占位符：{{analysis}} {{brief}} {{houseRules}} {{refs}}',
  tplBlend: '必须保留占位符：{{refNo}} {{blendPrompt}}',
};

const TEMPLATE_FIELDS: { key: keyof Settings; label: string }[] = [
  { key: 'tplSystem', label: '系统块（锁定区）' },
  { key: 'tplRegion', label: '区域块' },
  { key: 'tplGlobal', label: '全局块' },
  { key: 'tplEnding', label: '收尾块' },
  { key: 'tplFaceRepair', label: '面部重修指令' },
  { key: 'tplRepair', label: '定点重修指令' },
  { key: 'tplPlate', label: '净版提取指令' },
  { key: 'tplAnalyze', label: 'AI筹备·角色识别提示词' },
  { key: 'tplPropose', label: 'AI筹备·特效见解提示词' },
  { key: 'tplEffectSystem', label: 'AI筹备·特效预演系统词' },
  { key: 'tplBlend', label: 'AI筹备·融入说明注入模板' },
];

const MOMO_MODEL_PRESETS = ['[Mo]nano-banana-pro', '[yu]gemini-nano-banana-2.1', 'gpt-image-2.5-sunburst'];
const GRSAI_MODEL_PRESETS = [
  'nano-banana-2.1',
  'nano-banana-2',
  'nano-banana-2-4k-cl',
  'nano-banana-2-cl',
  'nano-banana-pro',
  'nano-banana-pro-cl',
  'nano-banana-pro-4k-vip',
  'nano-banana-fast',
  'gpt-image-2',
];
const ANALYSIS_MODEL_PRESETS = ['doubao-seed-1.6', 'doubao-1.5-vision-pro', 'doubao-vision-pro-32k', 'doubao-1.5-vision-lite'];

export default function SettingsPage() {
  const { settings, refreshSettings, toast, refreshBalance, balance, balanceError } = useStore();
  const [form, setForm] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [analysisKeyDraft, setAnalysisKeyDraft] = useState('');
  const [effectKeyDraft, setEffectKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);

  useEffect(() => {
    if (settings) {
      setForm({ ...settings });
      setKeyDraft(settings.apiKey ? 'obf:***' : '');
      setAnalysisKeyDraft(settings.analysisApiKey ? 'obf:***' : '');
      setEffectKeyDraft(settings.effectApiKey ? 'obf:***' : '');
    }
  }, [settings]);

  if (!form) return <div className="loading-page">加载中…</div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const provider: 'momo' | 'grsai' =
    form.provider === 'auto' ? (/grsai|dakka/i.test(form.baseUrl) ? 'grsai' : 'momo') : form.provider;
  const modelPresets = [...(provider === 'grsai' ? GRSAI_MODEL_PRESETS : MOMO_MODEL_PRESETS), ...(testResult?.models ?? [])];

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const patch: Partial<Settings> = { ...form };
      if (keyDraft === 'obf:***') delete patch.apiKey;
      else patch.apiKey = keyDraft;
      if (analysisKeyDraft === 'obf:***') delete patch.analysisApiKey;
      else patch.analysisApiKey = analysisKeyDraft;
      if (effectKeyDraft === 'obf:***') delete patch.effectApiKey;
      else patch.effectApiKey = effectKeyDraft;
      await api.saveSettings(patch);
      await refreshSettings();
      setSaveMsg({ kind: 'ok', text: '已保存' });
      toast('设置已保存', 'success');
    } catch (e) {
      setSaveMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  /** 服务商协议切换立即持久化（避免“选了但没点保存”导致仍走旧通道） */
  const persistProtocol = async (field: 'analysisProtocol' | 'effectProtocol', value: string) => {
    set(field, value as never);
    try {
      await api.saveSettings({ [field]: value } as Partial<Settings>);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testConnection(keyDraft === 'obf:***' ? undefined : keyDraft, form.baseUrl);
      setTestResult({ ok: r.ok, text: r.ok ? r.message ?? '连接成功' : `失败：${r.error}`, models: r.models });
      if (r.ok) void refreshBalance();
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-grid">
        <h2 style={{ marginTop: 0 }}>设置</h2>
        <p className="settings-description">连接服务与配置生成。高级选项按需展开。</p>

        <div className="settings-group">
          <h3>连接与生成</h3>
          <div className="settings-cols">
            <div className="form-row">
              <label className="label">API Key</label>
              <input className="input" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="sk-…" />
              <div className="form-hint">密钥保存在本机，经混淆存储，未强加密。</div>
            </div>
            <div className="form-row">
              <label className="label">Base URL</label>
              <input className="input" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            </div>
            <div className="form-row">
              <label className="label">服务商</label>
              <select className="select" value={form.provider} onChange={(e) => set('provider', e.target.value as Settings['provider'])}>
                <option value="auto">自动识别（按 Base URL）</option>
                <option value="grsai">GrsAI（grsaiapi.com / grsai.ai / dakka）</option>
                <option value="momo">墨墨（Gemini 兼容 :generateContent）</option>
              </select>
            </div>
            <div className="form-row">
              <label className="label">模型 ID（最终合成）</label>
              <input className="input" value={form.modelId} onChange={(e) => set('modelId', e.target.value)} list="model-list" />
              <datalist id="model-list">
                {modelPresets.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="form-row">
              <label className="label">输出尺寸</label>
              <select className="select" value={form.imageSize} onChange={(e) => set('imageSize', e.target.value as Settings['imageSize'])}>
                <option value="1K">1K</option>
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
              <div className="form-hint">可先用 2K 确认效果，再切换 4K 输出成品；实际生成速度取决于远端。</div>
            </div>
            <div className="form-row">
              <label className="label">单张价格（元，仅费用统计）</label>
              <input className="input" type="number" step="0.01" value={form.pricePerImage} onChange={(e) => set('pricePerImage', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">离线模拟模式（无需 Key，演示/验收用）</label>
              <label className="element-row" style={{ width: 'fit-content' }}>
                <input type="checkbox" checked={form.mockApi} onChange={(e) => set('mockApi', e.target.checked)} />
                开启后不调用真实 API，返回原图模拟结果
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && <span className={testResult.ok ? 'settings-msg ok' : 'settings-msg err'}>{testResult.text}</span>}
          </div>
          <div className="form-hint" style={{ marginTop: 12 }}>
            余额：{balance
              ? `${fmtCost(balance.balance)}（剩余 ${balance.totalGranted > 0 ? Math.round((balance.remainQuota / balance.totalGranted) * 100) : '—'}%）`
              : balanceError && provider === 'grsai'
                ? '不可用（GrsAI 请在官网控制台查看余额）'
                : '不可用'}
            {' '}
            <button className="btn btn-sm" onClick={() => void refreshBalance()}>
              刷新余额
            </button>
          </div>
        </div>

        <details className="settings-group" open>
          <summary>AI 筹备（识别 → 特效预演）</summary>
          <p className="form-hint">
            识别/见解走多模态分析，特效预演走图像生成。两个服务商可独立配置（Base URL / API Key / 模型 / 协议），
            <strong>留空则沿用上方「连接与生成」的对应字段</strong>。
          </p>

          <div className="settings-subblock">
            <div className="settings-subhead">分析服务商（角色识别 + 特效见解，如豆包视觉）</div>
            <div className="settings-cols">
              <div className="form-row">
                <label className="label">协议（切换后立即生效，无需另点保存）</label>
                <select className="select" value={form.analysisProtocol} onChange={(e) => void persistProtocol('analysisProtocol', e.target.value)}>
                  <option value="auto">自动识别（按服务商/协议依次尝试）</option>
                  <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
                  <option value="gemini">Gemini 兼容（:generateContent）</option>
                  <option value="doubao-web">豆包网页版（浏览器自动化，走网页版识别）</option>
                </select>
                {form.analysisProtocol === 'doubao-web' && <DoubaoLoginPanel />}
              </div>
              <div className="form-row">
                <label className="label">关闭思考模式（豆包思考模型大幅提速）</label>
                <label className="element-row" style={{ width: 'fit-content' }}>
                  <input
                    type="checkbox"
                    checked={form.analysisDisableThinking}
                    onChange={(e) => {
                      const v = e.target.checked;
                      set('analysisDisableThinking', v);
                      void api.saveSettings({ analysisDisableThinking: v }).catch((err) => toast(err instanceof Error ? err.message : String(err), 'error'));
                    }}
                  />
                  发送 thinking: disabled（切换后立即生效；中转站不支持时会自动去掉该参数重试）
                </label>
                <div className="form-hint">豆包 Seed 系默认先输出思维链：识别慢且可能把输出预算耗光。开启后实测大幅提速（图问答 15 秒 → 3~5 秒）。</div>
              </div>
              <div className="form-row">
                <label className="label">Base URL（留空沿用上方）</label>
                <input className="input" value={form.analysisBaseUrl} onChange={(e) => set('analysisBaseUrl', e.target.value)} placeholder={form.baseUrl || 'https://…'} />
              </div>
              <div className="form-row">
                <label className="label">API Key（留空沿用上方）</label>
                <input className="input" type="password" value={analysisKeyDraft} onChange={(e) => setAnalysisKeyDraft(e.target.value)} placeholder="专用 Key（本机混淆存储）" />
              </div>
              <div className="form-row">
                <label className="label">模型 ID</label>
                <input className="input" value={form.analysisModelId} onChange={(e) => set('analysisModelId', e.target.value)} list="analysis-model-list" />
                <datalist id="analysis-model-list">
                  {ANALYSIS_MODEL_PRESETS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="form-row">
                <label className="label">等待上限（秒）</label>
                <input className="input" type="number" min={30} max={900} value={form.analysisTimeoutSec} onChange={(e) => set('analysisTimeoutSec', Number(e.target.value))} />
              </div>
            </div>
          </div>

          <div className="settings-subblock">
            <div className="settings-subhead">特效服务商（1K 预演草图，如 image2.5 / gpt-image 系）</div>
            <div className="settings-cols">
              <div className="form-row">
                <label className="label">协议（切换后立即生效，无需另点保存）</label>
                <select className="select" value={form.effectProtocol} onChange={(e) => void persistProtocol('effectProtocol', e.target.value)}>
                  <option value="auto">自动识别（按 Base URL）</option>
                  <option value="grsai">GrsAI 系（/v1/draw/*）</option>
                  <option value="momo">墨墨/Gemini 兼容（:generateContent）</option>
                </select>
              </div>
              <div className="form-row">
                <label className="label">Base URL（留空沿用上方）</label>
                <input className="input" value={form.effectBaseUrl} onChange={(e) => set('effectBaseUrl', e.target.value)} placeholder={form.baseUrl || 'https://…'} />
              </div>
              <div className="form-row">
                <label className="label">API Key（留空沿用上方）</label>
                <input className="input" type="password" value={effectKeyDraft} onChange={(e) => setEffectKeyDraft(e.target.value)} placeholder="专用 Key（本机混淆存储）" />
              </div>
              <div className="form-row">
                <label className="label">模型 ID</label>
                <input className="input" value={form.effectModelId} onChange={(e) => set('effectModelId', e.target.value)} list="effect-model-list" />
                <datalist id="effect-model-list">
                  {['gpt-image-2.5-sunburst', 'gpt-image-2', 'nano-banana-pro'].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <div className="form-hint">生成 1K 级特效预演图；后续交付合成会超分回原图分辨率。</div>
              </div>
            </div>
          </div>

          <div className="form-row">
            <label className="label">工作室要求（注入特效见解）</label>
            <textarea
              className="textarea"
              rows={3}
              placeholder="例：保持真实光影与材质质感；特效不要覆盖人物面部；风格偏电影感，不要过饱和"
              value={form.prepHouseRules}
              onChange={(e) => set('prepHouseRules', e.target.value)}
            />
            <div className="form-hint">每笔客单生成特效见解时会与客户要求一起交给分析模型。</div>
          </div>
        </details>

        <details className="settings-group" open>
          <summary>队列、通知与质检</summary>
          <div className="settings-cols">
            <div className="form-row">
              <label className="label">并行生成数（1~4）</label>
              <input className="input" type="number" min={1} max={4} value={form.queueConcurrency} onChange={(e) => set('queueConcurrency', Number(e.target.value))} />
              <div className="form-hint">提高并发可减少多笔客单排队，单笔生成速度取决于远端。频繁限流时降到 2。</div>
            </div>
            <div className="form-row">
              <label className="label">生成等待上限（秒）</label>
              <input className="input" type="number" min={60} max={1800} value={form.runTimeoutSec} onChange={(e) => set('runTimeoutSec', Number(e.target.value))} />
              <div className="form-hint">4K 建议 600 秒。限流重试共用这一时间预算；连接中断后先核对远端记录，再决定是否重试。</div>
            </div>
            <div className="form-row">
              <label className="label">系统通知（Windows toast）</label>
              <label className="element-row" style={{ width: 'fit-content' }}>
                <input type="checkbox" checked={form.notifyToast} onChange={(e) => set('notifyToast', e.target.checked)} />
                完成 / 失败时弹出通知
              </label>
            </div>
            <div className="form-row">
              <label className="label">提示音</label>
              <label className="element-row" style={{ width: 'fit-content' }}>
                <input type="checkbox" checked={form.notifySound} onChange={(e) => set('notifySound', e.target.checked)} />
                完成 / 失败时播放音效
              </label>
            </div>
            <div className="form-row">
              <label className="label">身份通过阈值（≥ 通过）</label>
              <input className="input" type="number" step="0.01" value={form.qcIdentityPass} onChange={(e) => set('qcIdentityPass', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">身份中分下限（≥ 中分，自动面部重修）</label>
              <input className="input" type="number" step="0.01" value={form.qcIdentityMid} onChange={(e) => set('qcIdentityMid', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">自动面部重修</label>
              <label className="element-row" style={{ width: 'fit-content' }}>
                <input type="checkbox" checked={form.qcAutoFaceRepair} onChange={(e) => set('qcAutoFaceRepair', e.target.checked)} />
                中分时自动重修 1 次
              </label>
            </div>
            <div className="form-row">
              <label className="label">锁脸（复制图层，最后一步）</label>
              <label className="element-row" style={{ width: 'fit-content' }}>
                <input type="checkbox" checked={form.qcFaceLock} onChange={(e) => set('qcFaceLock', e.target.checked)} />
                交付前把原图脸区对齐贴回（宽羽化 + 光照匹配）
              </label>
              <div className="form-hint">无论是否做过面部重修都会执行；用原图全分辨率像素锁住身份，复检相似度以硬门槛判定。</div>
            </div>
            <div className="form-row">
              <label className="label">锁脸硬门槛（复检 ≥ 通过）</label>
              <input className="input" type="number" step="0.01" min={0.5} max={1} value={form.qcFaceLockPass} onChange={(e) => set('qcFaceLockPass', Number(e.target.value))} />
              <div className="form-hint">默认 0.95；锁脸后复检低于该值标记为未达标转人工（结果仍保留锁脸图）。</div>
            </div>
            <div className="form-row">
              <label className="label">素材发送长边上限（px）</label>
              <input className="input" type="number" value={form.sendMaxDimension} onChange={(e) => set('sendMaxDimension', Number(e.target.value))} />
              <div className="form-hint">超限等比缩小后发送；默认 4096，追求输入保真可设 6144（模型看到原图全分辨率）。体积超出接口上限时会自动逐档降档（优先保分辨率），不会一步缩到 2048。</div>
            </div>
            <div className="form-row">
              <label className="label">超分引擎（交付强制回填原图分辨率）</label>
              <select className="select" value={form.upscaleEngine} onChange={(e) => set('upscaleEngine', e.target.value as Settings['upscaleEngine'])}>
                <option value="realesrgan">Real-ESRGAN（本地超分，细节增强）</option>
                <option value="lanczos">Lanczos（快速缩放，无增强）</option>
              </select>
              <div className="form-hint">生成结果在质检前强制超分/缩放回填到原图逐像素尺寸。Real-ESRGAN 未安装或运行失败时自动降级 Lanczos 并在审核页标注；安装请运行 npm run setup-upscaler。</div>
            </div>
            <div className="form-row">
              <label className="label">超分超时（秒，独立于生成等待）</label>
              <input className="input" type="number" min={60} max={3600} value={form.upscaleTimeoutSec} onChange={(e) => set('upscaleTimeoutSec', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">素材数软上限（参考图，默认 4）</label>
              <input className="input" type="number" value={form.materialSoftLimit} onChange={(e) => set('materialSoftLimit', Number(e.target.value))} />
            </div>
          </div>
        </details>

        <details className="settings-group">
          <summary>提示词模板</summary>
          <p className="form-hint">可编辑模板文案，请保留 {'{{ }}'} 中的占位符。</p>
          {TEMPLATE_FIELDS.map((t) => (
            <div className="form-row" key={t.key}>
              <label className="label">{t.label}</label>
              <textarea
                className="textarea tpl-editor"
                rows={4}
                value={String(form[t.key])}
                onChange={(e) => set(t.key, e.target.value as never)}
              />
              {PLACEHOLDER_HINTS[t.key] && <div className="form-hint">{PLACEHOLDER_HINTS[t.key]}</div>}
            </div>
          ))}
        </details>

        <details className="settings-group">
          <summary>本地存储</summary>
          <div className="form-row">
            <label className="label">工作区路径（更改需重启应用）</label>
            <input className="input" value={form.workspacePath} onChange={(e) => set('workspacePath', e.target.value)} />
            <div className="form-hint">默认 ./workspace。文件（jobs / library / trash / logs / db.sqlite / config.json）均存于此目录，数据不出本机。</div>
          </div>
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!window.confirm('清空回收站？将删除 workspace/trash 下所有文件，不可恢复。')) return;
              try {
                const r = await api.emptyTrash();
                toast(`回收站已清空（移除 ${r.removed} 项）`);
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'error');
              }
            }}
          >
            清空回收站
          </button>
        </details>

        <div className="settings-actions">
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          {saveMsg && <span className={saveMsg.kind === 'ok' ? 'settings-msg ok' : 'settings-msg err'}>{saveMsg.text}</span>}
        </div>
      </div>
    </div>
  );
}

function DoubaoLoginPanel() {
  const { toast } = useStore();
  const [st, setSt] = useState<{ browserInstalled: boolean; loginState: string; loginError: string } | null>(null);
  const prev = useRef<string>('idle');

  const refresh = useCallback(
    async (notify: boolean) => {
      try {
        const s = await api.doubaoStatus();
        if (notify && s.loginState === 'done' && prev.current === 'waiting') toast('豆包登录成功', 'success');
        if (notify && s.loginState === 'error' && prev.current === 'waiting') toast(s.loginError || '登录未完成，可重试', 'error');
        prev.current = s.loginState;
        setSt(s);
      } catch {
        /* 状态查询失败不打断设置页 */
      }
    },
    [toast]
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    if (st?.loginState !== 'waiting') return;
    const t = window.setInterval(() => void refresh(true), 2500);
    return () => window.clearInterval(t);
  }, [st?.loginState, refresh]);

  const startLogin = async () => {
    try {
      const r = await api.doubaoLogin();
      toast(r.message, 'info');
      prev.current = 'waiting';
      setSt((s) => (s ? { ...s, loginState: 'waiting' } : s));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div className="settings-subblock" style={{ marginTop: 8 }}>
      <div className="settings-subhead">豆包网页版登录</div>
      <div className="form-hint" style={{ marginBottom: 8 }}>
        走网页版识别（浏览器自动化，与小红书方案相同）：能力与速度以网页版为准；自动化有账号风控风险，建议保持人工节奏、勿高并发。
        识别/见解会在<strong>屏幕外的后台浏览器</strong>中执行（不打扰操作），仅登录这一步需要弹窗扫码。
        {st !== null && !st.browserInstalled && (
          <>
            {' '}
            浏览器组件未安装：请先运行 <code>npx playwright install chromium</code>。
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="btn btn-sm"
          disabled={st?.loginState === 'waiting' || (st !== null && !st.browserInstalled)}
          onClick={() => void startLogin()}
        >
          {st?.loginState === 'waiting' ? '等待扫码…' : st?.loginState === 'done' ? '重新登录' : '扫码登录'}
        </button>
        <span
          className={st?.loginState === 'done' ? 'settings-msg ok' : st?.loginState === 'error' ? 'settings-msg err' : 'muted'}
          style={{ fontSize: 12 }}
        >
          {st?.loginState === 'done'
            ? '已登录'
            : st?.loginState === 'waiting'
              ? '已打开登录窗口，请在浏览器中扫码'
              : st?.loginState === 'error'
                ? st.loginError || '登录未完成，可重试'
                : '未登录（首次使用前需扫码一次）'}
        </span>
      </div>
    </div>
  );
}
