import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { fmtCost } from '../util';
import type { Settings } from '../types';

const PLACEHOLDER_HINTS: Partial<Record<keyof Settings, string>> = {
  tplRegion: '必须保留占位符：{{color}} {{n}} {{location}} {{instruction}}',
  tplGlobal: '必须保留占位符：{{globalInstruction}}',
  tplRepair: '必须保留占位符：{{color}} {{n}} {{location}} {{repairInstruction}}',
  tplPlate: '必须保留占位符：{{effectDescription}}',
};

const TEMPLATE_FIELDS: { key: keyof Settings; label: string }[] = [
  { key: 'tplSystem', label: '系统块（锁定区）' },
  { key: 'tplRegion', label: '区域块' },
  { key: 'tplGlobal', label: '全局块' },
  { key: 'tplEnding', label: '收尾块' },
  { key: 'tplFaceRepair', label: '面部重修指令' },
  { key: 'tplRepair', label: '定点重修指令' },
  { key: 'tplPlate', label: '净版提取指令' },
];

export default function SettingsPage() {
  const { settings, refreshSettings, toast, refreshBalance, balance } = useStore();
  const [form, setForm] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);

  useEffect(() => {
    if (settings) {
      setForm({ ...settings });
      setKeyDraft(settings.apiKey ? 'obf:***' : '');
    }
  }, [settings]);

  if (!form) return <div className="loading-page">加载中…</div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const patch: Partial<Settings> = { ...form };
      if (keyDraft === 'obf:***') delete patch.apiKey;
      else patch.apiKey = keyDraft;
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

        <div className="settings-group">
          <h3>API（墨墨中转站）</h3>
          <div className="settings-cols">
            <div className="form-row">
              <label className="label">API Key（本地存储，obf 混淆，非强加密）</label>
              <input className="input" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="sk-…" />
            </div>
            <div className="form-row">
              <label className="label">Base URL</label>
              <input className="input" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            </div>
            <div className="form-row">
              <label className="label">模型 ID</label>
              <input className="input" value={form.modelId} onChange={(e) => set('modelId', e.target.value)} list="model-list" />
              <datalist id="model-list">
                <option value="[Mo]nano-banana-pro" />
                <option value="[yu]gemini-nano-banana-2.1" />
                <option value="gpt-image-2.5-sunburst" />
                {testResult?.models?.map((m) => (
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
            余额：{balance ? `${fmtCost(balance.balance)}（剩余 ${balance.totalGranted > 0 ? Math.round((balance.remainQuota / balance.totalGranted) * 100) : '—'}%）` : '不可用'}
            {' '}
            <button className="btn btn-sm" onClick={() => void refreshBalance()}>
              刷新余额
            </button>
          </div>
        </div>

        <div className="settings-group">
          <h3>队列 / 通知 / 质检</h3>
          <div className="settings-cols">
            <div className="form-row">
              <label className="label">并行生成数（1~4）</label>
              <input className="input" type="number" min={1} max={4} value={form.queueConcurrency} onChange={(e) => set('queueConcurrency', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">单 Run 超时（秒）</label>
              <input className="input" type="number" value={form.runTimeoutSec} onChange={(e) => set('runTimeoutSec', Number(e.target.value))} />
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
              <label className="label">素材发送长边上限（px）</label>
              <input className="input" type="number" value={form.sendMaxDimension} onChange={(e) => set('sendMaxDimension', Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">素材数软上限（参考图，默认 4）</label>
              <input className="input" type="number" value={form.materialSoftLimit} onChange={(e) => set('materialSoftLimit', Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="settings-group">
          <h3>提示词模板（占位符 {'{{ }}'} 不可删改，可编辑文案）</h3>
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
        </div>

        <div className="settings-group">
          <h3>存储</h3>
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
        </div>

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
