import { describe, expect, it } from 'vitest';
import { defaultSettings, resolveAnalysisSettings, resolveEffectSettings } from '../src/settings';

describe('AI 筹备服务商解析（独立配置，留空沿用全局）', () => {
  it('全留空 → 完全沿用全局连接配置', () => {
    const s = { ...defaultSettings(), baseUrl: 'https://main.example.com', apiKey: 'obf:MAIN', provider: 'grsai' as const, modelId: 'nano-banana-pro' };
    const a = resolveAnalysisSettings(s);
    expect(a.baseUrl).toBe('https://main.example.com');
    expect(a.apiKey).toBe('obf:MAIN');
    const e = resolveEffectSettings(s);
    expect(e.baseUrl).toBe('https://main.example.com');
    expect(e.apiKey).toBe('obf:MAIN');
    expect(e.provider).toBe('grsai');
    expect(e.modelId).toBe(s.effectModelId);
  });

  it('分析服务商独立配置生效', () => {
    const s = {
      ...defaultSettings(),
      baseUrl: 'https://main.example.com',
      apiKey: 'obf:MAIN',
      analysisBaseUrl: 'https://doubao.example.com',
      analysisApiKey: 'obf:ANALYSIS',
    };
    const a = resolveAnalysisSettings(s);
    expect(a.baseUrl).toBe('https://doubao.example.com');
    expect(a.apiKey).toBe('obf:ANALYSIS');
    // 其它任务不受影响
    const e = resolveEffectSettings(s);
    expect(e.baseUrl).toBe('https://main.example.com');
    expect(e.apiKey).toBe('obf:MAIN');
  });

  it('特效服务商独立配置：baseUrl 生效时协议回到按地址自动识别，显式协议优先', () => {
    const s = {
      ...defaultSettings(),
      baseUrl: 'https://main.example.com',
      provider: 'momo' as const,
      apiKey: 'obf:MAIN',
      effectBaseUrl: 'https://sub.grsaiapi.com',
      effectModelId: 'gpt-image-2',
    };
    const e1 = resolveEffectSettings(s);
    expect(e1.baseUrl).toBe('https://sub.grsaiapi.com');
    expect(e1.provider).toBe('auto');
    expect(e1.modelId).toBe('gpt-image-2');

    const e2 = resolveEffectSettings({ ...s, effectProtocol: 'momo' });
    expect(e2.provider).toBe('momo');
  });

  it('特效模型 ID 留空 → 回退全局模型 ID', () => {
    const s = { ...defaultSettings(), modelId: 'nano-banana-pro', effectModelId: '' };
    expect(resolveEffectSettings(s).modelId).toBe('nano-banana-pro');
  });
});
