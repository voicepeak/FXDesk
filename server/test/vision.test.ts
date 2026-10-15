import { describe, expect, it } from 'vitest';
import { buildChatBody, buildGeminiBody, extractChatText, extractGeminiText, extractJsonObject, visionProtocolOrder, VisionError } from '../src/vision';
import { defaultSettings } from '../src/settings';

describe('多模态分析 · 响应解析', () => {
  it('chat/completions：字符串 content', () => {
    expect(extractChatText({ choices: [{ message: { content: '你好' } }] })).toBe('你好');
  });

  it('chat/completions：分段 content 数组拼接', () => {
    expect(extractChatText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] } }] })).toBe('ab');
  });

  it('chat/completions：错误信封抛错', () => {
    expect(() => extractChatText({ error: { message: 'bad key' } })).toThrowError(/bad key/);
  });

  it('generateContent：合并 parts 文本', () => {
    expect(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'x' }, { text: 'y' }] } }] })).toBe('xy');
  });

  it('generateContent：安全拦截', () => {
    expect(() => extractGeminiText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrowError(/安全/);
  });
});

describe('多模态分析 · JSON 抠取', () => {
  it('容忍 markdown 代码块与前后解释', () => {
    const raw = '好的，这是结果：\n```json\n{"character":"明日香","work":"EVA"}\n```\n以上。';
    expect(extractJsonObject(raw)).toEqual({ character: '明日香', work: 'EVA' });
  });

  it('无 JSON 时抛 VISION_OUTPUT_NOT_JSON', () => {
    try {
      extractJsonObject('抱歉，我无法识别');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VisionError);
      expect((e as VisionError).code).toBe('VISION_OUTPUT_NOT_JSON');
    }
  });

  it('截断 JSON 抛错而不是静默返回', () => {
    expect(() => extractJsonObject('{"a": 1')).toThrowError(VisionError);
  });
});

describe('多模态分析 · 请求体', () => {
  it('chat 请求体包含系统提示、图片 data URL 与模型名', () => {
    const body = buildChatBody('doubao-vision-pro', 'SYS', 'USER', [{ mime: 'image/png', base64: 'AAA' }]) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe('doubao-vision-pro');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    const content = body.messages[1].content as { type: string; image_url?: { url: string }; text?: string }[];
    expect(content[0]).toEqual({ type: 'text', text: 'USER' });
    expect(content[1].image_url?.url).toBe('data:image/png;base64,AAA');
  });

  it('gemini 请求体把系统提示并入文本部分', () => {
    const body = buildGeminiBody('SYS', 'USER', [{ mime: 'image/jpeg', base64: 'BBB' }]) as {
      contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
    };
    const parts = body.contents[0].parts;
    expect(parts[0].text).toBe('SYS\n\nUSER');
    expect(parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: 'BBB' });
  });

  it('关闭思考：chat 请求体带 thinking:disabled；默认不带', () => {
    const withNoThink = buildChatBody('m', 'S', 'U', [], { disableThinking: true }) as { thinking?: { type: string } };
    expect(withNoThink.thinking).toEqual({ type: 'disabled' });
    const without = buildChatBody('m', 'S', 'U', []) as { thinking?: unknown };
    expect(without.thinking).toBeUndefined();
  });
});

describe('多模态分析 · 协议顺序', () => {
  it('显式协议优先', () => {
    expect(visionProtocolOrder({ ...defaultSettings(), analysisProtocol: 'openai' })).toEqual(['chat', 'gemini']);
    expect(visionProtocolOrder({ ...defaultSettings(), analysisProtocol: 'gemini' })).toEqual(['gemini', 'chat']);
  });

  it('auto：GrsAI 系优先 OpenAI 兼容，其余优先 Gemini 兼容', () => {
    expect(visionProtocolOrder({ ...defaultSettings(), provider: 'grsai' })).toEqual(['chat', 'gemini']);
    expect(visionProtocolOrder({ ...defaultSettings(), provider: 'momo' })).toEqual(['gemini', 'chat']);
  });
});
