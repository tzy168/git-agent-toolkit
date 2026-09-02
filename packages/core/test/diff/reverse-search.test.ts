import { describe, expect, it } from 'vitest';

import { extractChangedSymbols, reverseSearch, REVERSE_MAX_DEPTH } from '../../src/diff/reverse-search.js';
import type { GitProvider } from '../../src/git/types.js';
import type { FileChange } from '../../src/types.js';

function fileOf(path: string, lines: { type: 'add' | 'del' | 'ctx'; text: string; oldNo?: number | null; newNo?: number | null }[]): FileChange {
  return {
    path,
    status: 'M',
    additions: lines.filter((l) => l.type === 'add').length,
    deletions: lines.filter((l) => l.type === 'del').length,
    isBinary: false,
    isGenerated: false,
    language: 'ts',
    hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: lines.map((l) => ({ ...l, oldNo: l.oldNo ?? null, newNo: l.newNo ?? null })) }],
  };
}

describe('extractChangedSymbols', () => {
  it('+/- 并存记为 modified，带签名与行号', () => {
    const syms = extractChangedSymbols([
      fileOf('src/a.ts', [
        { type: 'del', text: 'export function foo(a: number) {', oldNo: 3 },
        { type: 'add', text: 'export function foo(a: string) {', newNo: 3 },
      ]),
    ]);
    expect(syms).toHaveLength(1);
    expect(syms[0]).toMatchObject({ path: 'src/a.ts', name: 'foo', kind: 'function', change: 'modified' });
    expect(syms[0]!.signature).toBe('export function foo(a: string) {');
    expect(syms[0]!.hunkLine).toBe(3);
  });

  it('纯新增 / 纯删除分别记 added / removed', () => {
    const syms = extractChangedSymbols([
      fileOf('src/a.ts', [
        { type: 'add', text: 'export const bar = 1;', newNo: 1 },
        { type: 'del', text: 'export interface Baz {}', oldNo: 9 },
      ]),
    ]);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
    expect(byName.bar).toMatchObject({ kind: 'const', change: 'added' });
    expect(byName.Baz).toMatchObject({ kind: 'type', change: 'removed' });
  });

  it('tsx 大写函数归类为 component；声明行之外的普通行不提符号', () => {
    const syms = extractChangedSymbols([
      fileOf('src/ui/x.tsx', [
        { type: 'add', text: 'export function Dialog(props: P) {', newNo: 1 },
        { type: 'add', text: '  const v = helper();', newNo: 2 },
      ]),
    ]);
    expect(syms).toHaveLength(1);
    expect(syms[0]).toMatchObject({ name: 'Dialog', kind: 'component' });
  });
});

/** 假 git：repo 内容全部预置，searchText 做行级正则扫描 */
function fakeGit(files: Record<string, string>): GitProvider {
  return {
    async getRepoInfo() {
      return { root: '/repo' };
    },
    async listRepoFiles() {
      return Object.keys(files);
    },
    async searchText(pattern: RegExp, opts: { maxHits?: number } = {}) {
      const hits: { path: string; line: number; text: string }[] = [];
      const cap = opts.maxHits ?? 100;
      for (const [path, text] of Object.entries(files)) {
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) hits.push({ path, line: i + 1, text: line });
          if (hits.length >= cap) return hits;
        }
      }
      return hits;
    },
    async getFileAt(_ref: string, path: string) {
      return files[path] ?? null;
    },
  } as unknown as GitProvider;
}

describe('reverseSearch', () => {
  const files = {
    'src/a.ts': 'export function foo() {}\n',
    'src/b.ts': "import { foo } from './a.js';\nexport function bar() {\n  return foo();\n}\n",
    'src/c.ts': "import { bar } from './b.js';\nbar();\n",
    'src/a.test.ts': 'foo();\n',
  };

  it('direct + 经封装上溯出 indirect（depth 2）', async () => {
    const symbols = extractChangedSymbols([fileOf('src/a.ts', [{ type: 'add', text: 'export function foo() {}', newNo: 1 }])]);
    const result = await reverseSearch(fakeGit(files), symbols, { maxDepth: 2, includeTests: false, mode: 'grep' });

    expect(result.mode).toBe('grep');
    expect(result.truncated).toBe(false);
    // direct：b.ts 中对 foo 的引用（定义文件自身已排除）
    expect(result.direct.some((h) => h.path === 'src/b.ts' && h.symbol === 'foo' && h.depth === 1)).toBe(true);
    // indirect：c.ts 经 bar 引用 foo
    const indirect = result.indirect.find((h) => h.path === 'src/c.ts');
    expect(indirect).toMatchObject({ symbol: 'bar', depth: 2, via: 'foo' });
  });

  it('includeTests=false 时过滤测试文件', async () => {
    const symbols = extractChangedSymbols([fileOf('src/a.ts', [{ type: 'add', text: 'export function foo() {}', newNo: 1 }])]);
    const off = await reverseSearch(fakeGit(files), symbols, { maxDepth: 1, includeTests: false, mode: 'grep' });
    expect(off.direct.some((h) => h.path === 'src/a.test.ts')).toBe(false);
    const on = await reverseSearch(fakeGit(files), symbols, { maxDepth: 1, includeTests: true, mode: 'grep' });
    expect(on.direct.some((h) => h.path === 'src/a.test.ts')).toBe(true);
  });

  it('maxDepth 硬夹到 2', async () => {
    const symbols = extractChangedSymbols([fileOf('src/a.ts', [{ type: 'add', text: 'export function foo() {}', newNo: 1 }])]);
    const result = await reverseSearch(fakeGit(files), symbols, { maxDepth: 99, includeTests: false, mode: 'grep' });
    expect(REVERSE_MAX_DEPTH).toBe(2);
    expect(result.indirect.every((h) => h.depth <= 2)).toBe(true);
  });
});
