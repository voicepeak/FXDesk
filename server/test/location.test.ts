import { describe, expect, it } from 'vitest';
import { locationOf } from '../src/prompt';

const W = 300;
const H = 300;

const cell = (x1: number, y1: number, x2: number, y2: number) => locationOf({ x1, y1, x2, y2 }, W, H).split('，')[0];

describe('方位描述算法（九宫格 9 用例）', () => {
  it('左上部', () => {
    expect(cell(10, 10, 40, 40)).toBe('画面左上部');
  });
  it('中上部', () => {
    expect(cell(120, 10, 180, 40)).toBe('画面中上部');
  });
  it('右上部', () => {
    expect(cell(260, 10, 290, 40)).toBe('画面右上部');
  });
  it('左侧中部', () => {
    expect(cell(10, 120, 40, 180)).toBe('画面左侧中部');
  });
  it('中央', () => {
    expect(cell(120, 120, 180, 180)).toBe('画面中央');
  });
  it('右侧中部', () => {
    expect(cell(260, 120, 290, 180)).toBe('画面右侧中部');
  });
  it('左下部', () => {
    expect(cell(10, 260, 40, 290)).toBe('画面左下部');
  });
  it('中下部', () => {
    expect(cell(120, 260, 180, 290)).toBe('画面中下部');
  });
  it('右下部', () => {
    expect(cell(260, 260, 290, 290)).toBe('画面右下部');
  });
  it('边界：cx=0.33 归中列，cx=0.66 归右列', () => {
    // cx = 99/300 = 0.33 → 中列（非左列），cy = 150/300 = 0.5 → 中行 → 中央
    expect(cell(94, 120, 104, 180)).toBe('画面中央');
    // cx = 198/300 = 0.66 → 右列，cy 中行
    expect(cell(194, 120, 202, 180)).toBe('画面右侧中部');
  });
});

describe('面积档位（3 档）', () => {
  const areaText = (h: number) => locationOf({ x1: 0, y1: 0, x2: 1000, y2: h }, 1000, 1000).split('，')[1];

  it('覆盖范围较小（<8%）', () => {
    expect(areaText(79)).toBe('覆盖范围较小');
  });
  it('覆盖范围适中（8%~35%）', () => {
    expect(areaText(80)).toBe('覆盖范围适中');
    expect(areaText(349)).toBe('覆盖范围适中');
  });
  it('覆盖范围较大（≥35%）', () => {
    expect(areaText(350)).toBe('覆盖范围较大');
  });
});
