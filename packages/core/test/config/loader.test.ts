import { describe, expect, it } from 'vitest';

import { mergeConfigs } from '../../src/config/loader.js';

describe('mergeConfigs（四层合并的合并语义）', () => {
  it('普通对象递归合并', () => {
    const merged = mergeConfigs({ a: { b: 1, c: 2 }, keep: true }, { a: { b: 9, d: 4 } });
    expect(merged).toEqual({ a: { b: 9, c: 2, d: 4 }, keep: true });
  });

  it('数组整体替换（不逐项合并）', () => {
    const merged = mergeConfigs({ list: [1, 2, 3] }, { list: [9] });
    expect(merged.list).toEqual([9]);
  });

  it('patch 为 undefined 的键跳过', () => {
    const merged = mergeConfigs({ a: 1, b: 2 }, { a: undefined });
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('null 与标量直接覆盖', () => {
    expect(mergeConfigs({ a: { x: 1 } }, { a: null })).toEqual({ a: null });
    expect(mergeConfigs({ a: 1 }, { a: 'str' })).toEqual({ a: 'str' });
  });

  it('base 是标量时整体换成 patch 对象', () => {
    const merged = mergeConfigs({ a: 1 }, { a: { deep: true } });
    expect(merged).toEqual({ a: { deep: true } });
  });

  it('多层嵌套逐层递归', () => {
    const base = { git: { defaultBase: 'main', includeAuthors: ['a'] }, llm: { model: { fast: 'x', strong: 'y' } } };
    const merged = mergeConfigs(base, { llm: { model: { fast: 'z' } } });
    expect(merged.llm.model).toEqual({ fast: 'z', strong: 'y' });
    expect(merged.git.defaultBase).toBe('main');
  });

  it('patch 为 null/undefined 时返回 base 原引用', () => {
    const base = { a: 1 };
    expect(mergeConfigs(base, null)).toBe(base);
    expect(mergeConfigs(base, undefined)).toBe(base);
  });
});
