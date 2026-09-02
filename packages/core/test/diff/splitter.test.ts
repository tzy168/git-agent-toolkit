import { describe, expect, it } from 'vitest';

import { buildOutline, gradeScale, splitIntoChunks } from '../../src/diff/splitter.js';
import type { ResolvedConfig } from '../../src/config/types.js';
import type { FileChange } from '../../src/types.js';

const cfg = {
  diff: { smallThresholdTokens: 1000, largeThresholdTokens: 10000, enrichThresholdLines: 20, enrichMaxTokens: 2000 },
  llm: { chunkTargetTokens: 500 },
} as unknown as ResolvedConfig;

function fc(path: string, additions: number, deletions: number, hunks = 1): FileChange {
  return {
    path,
    status: 'M',
    additions,
    deletions,
    isBinary: false,
    isGenerated: false,
    language: 'ts',
    hunks: Array.from({ length: hunks }, () => ({
      oldStart: 1,
      oldLines: deletions,
      newStart: 1,
      newLines: additions,
      lines: [],
    })),
  };
}

/** 内容较大的文件：10 行 40 字符填充，estTokens ≈ 130 > budget/8，不触发碎桶合并 */
function bigFc(path: string): FileChange {
  const lines = Array.from({ length: 10 }, (_, i) => ({
    type: 'ctx' as const,
    text: `x`.repeat(39) + String(i),
    oldNo: i + 1,
    newNo: i + 1,
  }));
  return {
    ...fc(path, 0, 0),
    hunks: [{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 10, lines }],
  };
}

describe('gradeScale', () => {
  it('按阈值分级', () => {
    expect(gradeScale(999, cfg)).toBe('small');
    expect(gradeScale(1000, cfg)).toBe('medium');
    expect(gradeScale(9999, cfg)).toBe('medium');
    expect(gradeScale(10001, cfg)).toBe('large');
  });
});

describe('buildOutline', () => {
  it('每文件一行 numstat', () => {
    const text = buildOutline([fc('src/a.ts', 3, 1), fc('src/b.ts', 0, 2)]);
    expect(text.split('\n')).toEqual(['M\tsrc/a.ts\t+3\t-1', 'M\tsrc/b.ts\t+0\t-2']);
  });
});

describe('splitIntoChunks', () => {
  it('空输入返回空', () => {
    expect(splitIntoChunks([], cfg)).toEqual([]);
  });

  it('小 diff 聚成单桶，路径齐全', () => {
    const chunks = splitIntoChunks([fc('src/a.ts', 2, 1), fc('src/b.ts', 1, 0)], cfg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(chunks[0]!.id).toBe('c0');
    expect(chunks[0]!.text).toContain('diff --git');
  });

  it('不同目录分开成桶（桶不碎时不跨模块合并）', () => {
    // 每个文件 > budget/8（62.5 tokens），避免 mergeTiny 把碎桶合并
    const chunks = splitIntoChunks(
      [bigFc('src/core/a.ts'), bigFc('src/web/b.tsx'), bigFc('docs/readme.md')],
      cfg,
    );
    expect(chunks).toHaveLength(3);
    const modules = chunks.map((c) => c.module);
    expect(new Set(modules).size).toBe(modules.length);
  });

  it('碎桶（<3 文件且 token 很少）会跨模块合并减少调用次数', () => {
    const chunks = splitIntoChunks([fc('src/core/a.ts', 2, 0), fc('src/web/b.tsx', 2, 0), fc('docs/readme.md', 1, 0)], cfg);
    expect(chunks).toHaveLength(1);
  });
});
