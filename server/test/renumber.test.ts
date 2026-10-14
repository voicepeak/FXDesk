import { describe, expect, it } from 'vitest';
import { renumberRegions } from '../src/prompt';

describe('参考图重编号（§4.4.3）', () => {
  const regionA = {
    id: 'ra',
    instruction: '在手中添加参考图1的剑，旁边有参考图3的蝴蝶',
    ref_tokens: JSON.stringify([
      { materialId: 'm1', refNo: 1, name: '剑' },
      { materialId: 'm3', refNo: 3, name: '蝴蝶' },
    ]),
  };
  const regionB = {
    id: 'rb',
    instruction: '身后加参考图2的闪电',
    ref_tokens: JSON.stringify([{ materialId: 'm2', refNo: 2, name: '闪电' }]),
  };

  it('删除中间素材后：token 与附件顺序一致，文本同步改写', () => {
    const oldMats = [
      { id: 'm1', order_index: 1 },
      { id: 'm2', order_index: 2 },
      { id: 'm3', order_index: 3 },
    ];
    const newMats = [
      { id: 'm1', order_index: 1 },
      { id: 'm3', order_index: 2 },
    ];
    const updated = renumberRegions([regionA, regionB], oldMats, newMats, ['m2']);

    const a = updated.find((u) => u.id === 'ra')!;
    expect(a.instruction).toBe('在手中添加参考图1的剑，旁边有参考图2的蝴蝶');
    const aTokens = JSON.parse(a.ref_tokens) as { materialId: string; refNo: number }[];
    expect(aTokens.map((t) => [t.materialId, t.refNo])).toEqual([
      ['m1', 1],
      ['m3', 2],
    ]);

    const b = updated.find((u) => u.id === 'rb')!;
    expect(b.instruction).toBe('身后加已删除素材的闪电');
    expect(JSON.parse(b.ref_tokens)).toEqual([]);
  });

  it('重排素材后：token refNo 与文本改写一致', () => {
    const regionC = {
      id: 'rc',
      instruction: '在手中添加参考图1的剑，旁边有参考图2的蝴蝶',
      ref_tokens: JSON.stringify([
        { materialId: 'm1', refNo: 1, name: '剑' },
        { materialId: 'm3', refNo: 2, name: '蝴蝶' },
      ]),
    };
    const oldMats = [
      { id: 'm1', order_index: 1 },
      { id: 'm3', order_index: 2 },
    ];
    const newMats = [
      { id: 'm3', order_index: 1 },
      { id: 'm1', order_index: 2 },
    ];
    const updated = renumberRegions([regionC], oldMats, newMats, []);
    const a = updated[0];
    expect(a.instruction).toBe('在手中添加参考图2的剑，旁边有参考图1的蝴蝶');
    const aTokens = JSON.parse(a.ref_tokens) as { materialId: string; refNo: number }[];
    expect(aTokens.map((t) => [t.materialId, t.refNo])).toEqual([
      ['m1', 2],
      ['m3', 1],
    ]);
  });

  it('不误伤多位数字（参考图10 不匹配参考图1）', () => {
    const region = {
      id: 'rc',
      instruction: '添加参考图10与参考图1',
      ref_tokens: JSON.stringify([
        { materialId: 'm10', refNo: 10, name: 'A' },
        { materialId: 'm1', refNo: 1, name: 'B' },
      ]),
    };
    const oldMats = [
      { id: 'm1', order_index: 1 },
      { id: 'm10', order_index: 10 },
    ];
    const newMats = [
      { id: 'm1', order_index: 9 },
      { id: 'm10', order_index: 10 },
    ];
    const updated = renumberRegions([region], oldMats, newMats, []);
    expect(updated[0].instruction).toBe('添加参考图10与参考图9');
  });
});
