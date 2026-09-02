import { describe, expect, it } from 'vitest';

import { resolveAuthors } from '../../../src/features/shared/collect-log.js';
import type { FeatureContext } from '../../../src/features/registry.js';

function ctxOf(opts: { includeAuthors?: string[]; author?: { name: string; email: string } | null }): FeatureContext {
  return {
    config: { git: { includeAuthors: opts.includeAuthors ?? [] } },
    repo: { author: opts.author === undefined ? { name: 'Zhang San', email: 'zhang@x.com' } : opts.author },
    logger: { info() {}, warn() {} },
  } as unknown as FeatureContext;
}

describe('resolveAuthors（周报作者解析）', () => {
  it('默认只统计当前 git 用户', () => {
    expect(resolveAuthors(ctxOf({}), {})).toEqual(['Zhang San']);
  });

  it('user.name 为空时退到 user.email', () => {
    expect(resolveAuthors(ctxOf({ author: { name: '', email: 'zhang@x.com' } }), {})).toEqual(['zhang@x.com']);
  });

  it('CLI --authors 优先级最高', () => {
    expect(
      resolveAuthors(ctxOf({ includeAuthors: ['Config A'] }), { authors: ['Li Si', 'Wang Wu'] }),
    ).toEqual(['Li Si', 'Wang Wu']);
  });

  it('其次取配置 git.includeAuthors', () => {
    expect(resolveAuthors(ctxOf({ includeAuthors: ['Config A'] }), {})).toEqual(['Config A']);
  });

  it('--all-authors 显式统计所有人（返回空 = 不加 --author 过滤）', () => {
    expect(resolveAuthors(ctxOf({ includeAuthors: ['Config A'] }), { allAuthors: true })).toEqual([]);
  });

  it('识别不到当前用户时回退为统计所有人', () => {
    expect(resolveAuthors(ctxOf({ author: null }), {})).toEqual([]);
    expect(resolveAuthors(ctxOf({ author: { name: '', email: '' } }), {})).toEqual([]);
  });
});
