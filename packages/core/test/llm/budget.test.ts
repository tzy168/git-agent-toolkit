import { describe, expect, it } from 'vitest';

import { estimateTokens, remainingBudget, truncateToBudget, withinBudget } from '../../src/llm/budget.js';

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('ASCII 约 4 字符/token + 行开销（宁可高估）', () => {
    const one = estimateTokens('abcd'); // 4/4=1 + 0.5 → ceil = 2
    expect(one).toBe(2);
    const twoLines = estimateTokens('abcd\nefgh'); // 9 字符（含 \n）/4=2.25 + 行开销 1 → ceil = 4
    expect(twoLines).toBe(4);
  });

  it('CJK 更贵（约 1.5 字符/token）', () => {
    const cjk = estimateTokens('一二三'); // 3/1.5=2 + 0.5 → 3
    const ascii = estimateTokens('abc'); // 3/4 + 0.5 → 1
    expect(cjk).toBeGreaterThan(ascii);
  });
});

describe('withinBudget / remainingBudget', () => {
  it('边界值判断', () => {
    expect(withinBudget(10, 10)).toBe(true);
    expect(withinBudget(11, 10)).toBe(false);
    expect(remainingBudget(15, 10)).toBe(0);
    expect(remainingBudget(3, 10)).toBe(7);
  });
});

describe('truncateToBudget', () => {
  it('预算内原样返回', () => {
    const text = 'short';
    expect(truncateToBudget(text, 1000)).toBe(text);
  });

  it('预算 0 返回空串', () => {
    expect(truncateToBudget('anything', 0)).toBe('');
  });

  it('超预算截断并追加说明（保证小于原文）', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i}-padding-padding`).join('\n');
    const out = truncateToBudget(text, 50);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toMatch(/（已按预算截断）/);
  });
});
