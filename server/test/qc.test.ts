import { describe, expect, it } from 'vitest';
import { decideIdentity } from '../src/qc/identity';
import { cosineSimilarity, l2normalize } from '../src/qc/faces';

const PASS = 0.62;
const MID = 0.5;

describe('QC 身份阈值三档分流（§4.7.1，mock 特征向量）', () => {
  it('高相似度 → 通过，不触发重修', () => {
    const d = decideIdentity(0.9, PASS, MID, true);
    expect(d.verdict).toBe('pass');
    expect(d.shouldRepair).toBe(false);
  });

  it('恰达通过阈值 → 通过（≥ 0.62）', () => {
    const d = decideIdentity(0.62, PASS, MID, true);
    expect(d.verdict).toBe('pass');
  });

  it('中分区间 → 自动触发面部重修（开启时）', () => {
    const d = decideIdentity(0.55, PASS, MID, true);
    expect(d.verdict).toBe('mid');
    expect(d.shouldRepair).toBe(true);
  });

  it('中分区间下限边界（=0.50）→ 中分', () => {
    const d = decideIdentity(0.5, PASS, MID, true);
    expect(d.verdict).toBe('mid');
  });

  it('中分但关闭自动重修 → 不重修', () => {
    const d = decideIdentity(0.55, PASS, MID, false);
    expect(d.verdict).toBe('mid');
    expect(d.shouldRepair).toBe(false);
  });

  it('低于下限 → 不达标，不自动重跑', () => {
    const d = decideIdentity(0.499, PASS, MID, true);
    expect(d.verdict).toBe('fail');
    expect(d.shouldRepair).toBe(false);
  });

  it('mock 特征向量：余弦相似度计算正确', () => {
    const a = l2normalize(new Float32Array([1, 0, 0]));
    const b = l2normalize(new Float32Array([1, 0, 0]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);

    const c = l2normalize(new Float32Array([0, 1, 0]));
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6);

    const d1 = l2normalize(new Float32Array([3, 4, 0]));
    const d2 = l2normalize(new Float32Array([6, 8, 0]));
    expect(cosineSimilarity(d1, d2)).toBeCloseTo(1, 6);

    const e = l2normalize(new Float32Array([1, 1, 0]));
    const f = l2normalize(new Float32Array([1, -1, 0]));
    expect(cosineSimilarity(e, f)).toBeCloseTo(0, 6);
  });

  it('mock：高相似向量 → pass；低相似向量 → fail（端到端分流）', () => {
    const orig = l2normalize(new Float32Array(Array.from({ length: 512 }, (_, i) => Math.sin(i))));
    const sameFace = l2normalize(new Float32Array(Array.from({ length: 512 }, (_, i) => Math.sin(i) + 0.001 * Math.cos(i * 3))));
    const otherFace = l2normalize(new Float32Array(Array.from({ length: 512 }, (_, i) => Math.cos(i * 1.7) - 0.5)));
    const simSame = cosineSimilarity(orig, sameFace);
    const simOther = cosineSimilarity(orig, otherFace);
    expect(decideIdentity(simSame, PASS, MID, true).verdict).toBe('pass');
    expect(decideIdentity(simOther, PASS, MID, true).verdict).toBe('fail');
  });
});
