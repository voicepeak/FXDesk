import { describe, expect, it } from 'vitest';
import { closestAspectRatio } from '../src/imageGeometry';

describe('根据主图选择输出比例', () => {
  it.each([
    [2870, 3831, '3:4'],
    [3831, 2870, '4:3'],
    [1080, 1920, '9:16'],
    [1920, 1080, '16:9'],
    [1000, 1000, '1:1'],
    [4000, 5000, '4:5'],
  ])('%i × %i → %s', (w, h, expected) => {
    expect(closestAspectRatio(w, h)).toBe(expected);
    expect(closestAspectRatio(w / 2, h / 2)).toBe(expected);
  });

  it('拒绝无法读取的尺寸', () => {
    expect(() => closestAspectRatio(0, 100)).toThrow();
    expect(() => closestAspectRatio(100, NaN)).toThrow();
  });
});
