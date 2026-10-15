import { describe, expect, it } from 'vitest';
import {
  buildAnalysisUserPrompt,
  buildProposalPrompt,
  buildRefsList,
  defaultEffectRefs,
  isMaterialRole,
  normalizeAnalysis,
  normalizeProposal,
} from '../src/prep';
import type { MaterialRow } from '../src/types';

function mat(partial: Partial<MaterialRow> & { id: string }): MaterialRow {
  return {
    job_id: 'job-1',
    source: 'client',
    library_item_id: null,
    display_name: partial.id,
    file_path: null,
    order_index: 1,
    role: 'general',
    ...partial,
  };
}

describe('识别分析提问（带参考图）', () => {
  it('带参考图时说明数量，供模型一并参考', () => {
    expect(buildAnalysisUserPrompt('', 3)).toContain('另附 3 张参考图');
    expect(buildAnalysisUserPrompt('', 0)).not.toContain('参考图');
  });

  it('角色线索并入提问', () => {
    expect(buildAnalysisUserPrompt('明日香', 0)).toContain('角色线索：明日香');
  });
});

describe('识别结果归一化', () => {
  it('容错：缺字段、错误类型、超长文本', () => {
    const r = normalizeAnalysis({ character: ' 明日香 ', aliases: ['Asuka', 3, ''], confidence: 1.7, extra: 1 });
    expect(r.character).toBe('明日香');
    expect(r.work).toBe('');
    expect(r.aliases).toEqual(['Asuka', '3']);
    expect(r.confidence).toBe(1);
    expect(r.scene).toBe('');
  });

  it('完全非法输入不抛错', () => {
    const r = normalizeAnalysis(null);
    expect(r.character).toBe('');
    expect(r.confidence).toBeNull();
  });
});

describe('特效见解归一化', () => {
  it('refs 按 图2..图 N+1 编号过滤并去重；kind 白名单；最多 3 条', () => {
    const p = normalizeProposal(
      {
        summary: '方案',
        effects: [
          { title: 'A', kind: 'LIGHT', genPrompt: 'gA', blendPrompt: 'bA', refs: [2, 2, 3, 1, 0, 99, 'x'] },
          { title: 'B', kind: 'bad-kind', genPrompt: 'gB', refs: [] },
          { title: 'C', genPrompt: 'gC' },
          { title: 'D', genPrompt: 'gD' },
        ],
      },
      2
    );
    expect(p.effects).toHaveLength(3);
    expect(p.effects[0]).toMatchObject({ kind: 'light', refs: [2, 3] });
    expect(p.effects[1].kind).toBe('other');
  });

  it('空标题但有生成描述时用描述兜底；两者皆空则跳过', () => {
    const p = normalizeProposal({ effects: [{ genPrompt: '只有描述' }, { title: '' }, 'junk'] }, 0);
    expect(p.effects).toHaveLength(1);
    expect(p.effects[0].title).toBe('只有描述');
  });
});

describe('参考图清单与默认引用', () => {
  it('buildRefsList：场图为图1，素材从图2起编号并标注用途', () => {
    const list = buildRefsList([
      mat({ id: 'a', display_name: '剑', role: 'item' }),
      mat({ id: 'b', display_name: '闪电参考', role: 'style', order_index: 2 }),
    ]);
    expect(list).toBe('图2（物品参照）：剑\n图3（特效风格参照）：闪电参考');
  });

  it('无素材时给出明确说明', () => {
    expect(buildRefsList([])).toContain('仅场图');
  });

  it('defaultEffectRefs 排除分析与特效素材', () => {
    const ids = defaultEffectRefs([
      mat({ id: 'a', role: 'general' }),
      mat({ id: 'b', role: 'analysis' }),
      mat({ id: 'c', role: 'style' }),
      mat({ id: 'd', role: 'effect' }),
    ]);
    expect(ids).toEqual(['a', 'c']);
  });

  it('isMaterialRole 白名单', () => {
    expect(isMaterialRole('style')).toBe(true);
    expect(isMaterialRole('nope')).toBe(false);
    expect(isMaterialRole(undefined)).toBe(false);
  });
});

describe('特效见解提示词拼装', () => {
  it('注入分析/客户要求/工作室要求/参考清单', () => {
    const prompt = buildProposalPrompt({
      analysis: { character: '明日香', work: 'EVA', aliases: ['Asuka'], scene: '室内', confidence: 0.9, notes: '' },
      brief: '手上加剑',
      houseRules: '保持真实光影',
      refsList: '图2（物品参照）：剑',
      tplPropose: 'A={{analysis}}|B={{brief}}|C={{houseRules}}|D={{refs}}',
    });
    expect(prompt).toBe('A=角色：明日香；作品：EVA；别称：Asuka；场景：室内|B=手上加剑|C=保持真实光影|D=图2（物品参照）：剑');
  });

  it('空客户要求/工作室要求时给出占位文案', () => {
    const prompt = buildProposalPrompt({
      analysis: { character: '', work: '', aliases: [], scene: '', confidence: null, notes: '' },
      brief: '',
      houseRules: '',
      refsList: '',
      tplPropose: 'B={{brief}}|C={{houseRules}}',
    });
    expect(prompt).toBe('B=（未提供）|C=（无）');
  });
});
