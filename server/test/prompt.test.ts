import { describe, expect, it } from 'vitest';
import { assemblePrompt, applyTemplate, colorName, locationOf, paletteColor, regionLine } from '../src/prompt';
import type { AssembleTemplates } from '../src/prompt';

const templates: AssembleTemplates = {
  tplSystem: 'SYS-BLOCK',
  tplRegion: '【{{color}}框 第{{n}}区】位置：{{location}}。要求：{{instruction}}',
  tplGlobal: '【全局修改】{{globalInstruction}}',
  tplEnding: 'END-BLOCK',
};

describe('提示词拼装器（§4.4.4）', () => {
  it('2 区域 + 全局指令 → 快照式全文断言（含方位描述与参考图编号）', () => {
    const result = assemblePrompt({
      regions: [
        { idx: 1, color: '#E53935', bbox: { x1: 100, y1: 400, x2: 300, y2: 600 }, instruction: '手里加参考图1的剑' },
        { idx: 2, color: '#FDD835', bbox: { x1: 600, y1: 100, x2: 900, y2: 400 }, instruction: '身体周围加参考图2的闪电' },
      ],
      globalInstruction: '背景换成雨夜街道',
      templates,
      W: 1000,
      H: 1000,
    });

    const expected = [
      'SYS-BLOCK',
      '【红框 第1区】位置：画面左侧中部，覆盖范围较小。要求：手里加参考图1的剑',
      '【黄框 第2区】位置：画面右上部，覆盖范围适中。要求：身体周围加参考图2的闪电',
      '【全局修改】背景换成雨夜街道',
      'END-BLOCK',
    ].join('\n');

    expect(result.finalPrompt).toBe(expected);
    expect(result.blocks.map((b) => b.kind)).toEqual(['system', 'region', 'region', 'global', 'ending']);
  });

  it('全局指令为空时省略整段', () => {
    const result = assemblePrompt({
      regions: [{ idx: 1, color: '#1E88E5', bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, instruction: 'x' }],
      globalInstruction: '   ',
      templates,
      W: 1000,
      H: 1000,
    });
    expect(result.finalPrompt).not.toContain('【全局修改】');
    expect(result.blocks.some((b) => b.kind === 'global')).toBe(false);
  });

  it('区域按编号排序拼接', () => {
    const result = assemblePrompt({
      regions: [
        { idx: 2, color: '#FDD835', bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, instruction: 'B' },
        { idx: 1, color: '#E53935', bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, instruction: 'A' },
      ],
      globalInstruction: '',
      templates,
      W: 1000,
      H: 1000,
    });
    const i1 = result.finalPrompt.indexOf('要求：A');
    const i2 = result.finalPrompt.indexOf('要求：B');
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
  });

  it('模板变量替换与调色板循环', () => {
    expect(applyTemplate('值：{{a}}/{{b}}', { a: '1' })).toBe('值：1/{{b}}');
    expect(colorName('#E53935')).toBe('红');
    expect(colorName('#FDD835')).toBe('黄');
    expect(colorName('#8E24AA')).toBe('紫');
    expect(paletteColor(0)).toBe('#E53935');
    expect(paletteColor(5)).toBe('#E53935');
    expect(paletteColor(6)).toBe('#FDD835');
  });
});

describe('方位描述算法（附录 B.3）补充', () => {
  it('locationOf 组合格式', () => {
    expect(locationOf({ x1: 100, y1: 400, x2: 300, y2: 600 }, 1000, 1000)).toBe('画面左侧中部，覆盖范围较小');
  });
});

describe('素材融入说明注入（AI 筹备）', () => {
  const tpl: AssembleTemplates = {
    tplSystem: 'SYS',
    tplRegion: '【{{color}}框 第{{n}}区】位置：{{location}}。要求：{{instruction}}',
    tplGlobal: '【全局修改】{{globalInstruction}}',
    tplEnding: 'END',
    tplBlend: '【参考图{{refNo}}·融入要求】{{blendPrompt}}',
  };

  it('引用含 blend_prompt 的素材时，区域块自动附带融入要求', () => {
    const result = assemblePrompt({
      regions: [
        {
          idx: 1,
          color: '#E53935',
          bbox: { x1: 0, y1: 0, x2: 100, y2: 100 },
          instruction: '把参考图2的特效溶入',
          blendNotes: [{ refNo: 2, blendPrompt: '本特效环绕在人物身后，人物在前景遮挡' }],
        },
      ],
      globalInstruction: '',
      templates: tpl,
      W: 1000,
      H: 1000,
    });
    expect(result.finalPrompt).toContain('要求：把参考图2的特效溶入');
    expect(result.finalPrompt).toContain('【参考图2·融入要求】本特效环绕在人物身后，人物在前景遮挡');
  });

  it('无 blendNotes 或模板缺 tplBlend 时不注入', () => {
    const noNotes = assemblePrompt({
      regions: [{ idx: 1, color: '#E53935', bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, instruction: 'x' }],
      globalInstruction: '',
      templates: tpl,
      W: 1000,
      H: 1000,
    });
    expect(noNotes.finalPrompt).not.toContain('融入要求');

    const noTpl: AssembleTemplates = { ...tpl, tplBlend: undefined };
    const withNotes = assemblePrompt({
      regions: [
        { idx: 1, color: '#E53935', bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, instruction: 'x', blendNotes: [{ refNo: 1, blendPrompt: 'B' }] },
      ],
      globalInstruction: '',
      templates: noTpl,
      W: 1000,
      H: 1000,
    });
    expect(withNotes.finalPrompt).not.toContain('融入要求');
  });

  it('regionLine 预览包含融入要求（与最终提示词一致）', () => {
    const line = regionLine(
      {
        idx: 1,
        color: '#FDD835',
        bbox: { x1: 0, y1: 0, x2: 100, y2: 100 },
        instruction: 'x',
        blendNotes: [{ refNo: 3, blendPrompt: 'PREVIEW-BLEND' }],
      },
      tpl,
      1000,
      1000
    );
    expect(line).toContain('PREVIEW-BLEND');
  });
});
