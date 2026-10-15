import { describe, expect, it } from 'vitest';
import { extractNewReply, extractReplyAfterPrompt, isCapacityBlocked, mergeWebPrompt } from '../src/doubao';

describe('豆包网页版 · 算力限流识别', () => {
  it('识别高峰期算力文案', () => {
    expect(isCapacityBlocked('算力紧张，办公能力得晚点才能用了。开通订阅，享高峰期优先使用。')).toBe(true);
    expect(isCapacityBlocked('服务繁忙，请稍后再试')).toBe(true);
  });

  it('正常回复不误报', () => {
    expect(isCapacityBlocked('{"character":"明日香","work":"EVA"}')).toBe(false);
    expect(isCapacityBlocked('这是一张 cos 场照')).toBe(false);
  });
});

describe('豆包网页版 · 提示词拼接', () => {
  it('系统提示并入用户消息', () => {
    expect(mergeWebPrompt('SYS', 'USER')).toBe('SYS\n\nUSER');
    expect(mergeWebPrompt('  ', 'USER')).toBe('USER');
  });
});

describe('豆包网页版 · 回复提取', () => {
  it('取会话新增部分（公共前缀之后）', () => {
    expect(extractNewReply('旧对话内容', '旧对话内容\n这是新的回复')).toBe('这是新的回复');
  });

  it('去掉开头回显的提问文本', () => {
    expect(extractNewReply('旧对话', '旧对话\n我的问题\n回答B', '我的问题')).toBe('回答B');
  });

  it('页面重排导致非前缀时返回全文', () => {
    expect(extractNewReply('abc', '完全不同的会话文本')).toBe('完全不同的会话文本');
  });

  it('无历史时返回全部新增文本', () => {
    expect(extractNewReply('', '第一轮回复')).toBe('第一轮回复');
  });

  it('提取为空时回退全文，不返回空串', () => {
    expect(extractNewReply('same', 'same')).toBe('same');
  });
});

describe('豆包网页版 · 锚点定位回复（跳过提问回显与模板示例）', () => {
  const prompt = '你是识别助手。\n请输出 JSON：\n{"character":"角色名","work":"出自的作品名"}\nconfidence 为小数。无法确定时留空。';

  it('页面回显提问+模板示例后跟着真实回复时，只取回复', () => {
    const page = `旧对话\n用户\n${prompt}\n豆包\n{"character":"明日香","work":"EVA"} 识别完成`;
    const reply = extractReplyAfterPrompt(page, prompt);
    expect(reply).toBe('{"character":"明日香","work":"EVA"} 识别完成');
    expect(reply).not.toContain('角色名');
  });

  it('只有提问回显、还没有回复时返回空（不会把模板示例当回复）', () => {
    const page = `旧对话\n用户\n${prompt}`;
    expect(extractReplyAfterPrompt(page, prompt)).toBe('');
  });

  it('渲染存在空白差异也能命中锚点', () => {
    const page = `用户\n${prompt.replace(/ /g, '\n').replace(/：/g, '： ')}\n豆包\n回复内容`;
    expect(extractReplyAfterPrompt(page, prompt)).toBe('回复内容');
  });

  it('多次出现提问时取最后一次之后的回复', () => {
    const page = `用户\n${prompt}\n豆包\n第一次回复\n用户\n${prompt}\n豆包\n第二次回复`;
    expect(extractReplyAfterPrompt(page, prompt)).toBe('第二次回复');
  });

  it('剥掉「展开全部/时间戳/正在思考」等页面小标签', () => {
    const page = `用户\n${prompt}\n展开全部\n今天 16:51\n正在思考`;
    expect(extractReplyAfterPrompt(page, prompt)).toBe('');
  });

  it('思考标记之后跟着真实回复时只取回复', () => {
    const page = `用户\n${prompt}\n展开全部\n今天 16:51\n正在思考\n{"character":"明日香"}`;
    expect(extractReplyAfterPrompt(page, prompt)).toBe('{"character":"明日香"}');
  });
});
