import { describe, expect, it } from 'vitest';

import { parseDiff, statsOf } from '../../src/diff/parser.js';

describe('parseDiff', () => {
  it('空文本返回空数组', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('   \n  ')).toEqual([]);
  });

  it('解析多 hunk 且行号正确', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' ctx',
      '-old',
      '+new1',
      '+new2',
      '@@ -10,2 +11,2 @@',
      ' keep',
      '-x',
      '+y',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/a.ts');
    expect(f.status).toBe('M');
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.hunks).toHaveLength(2);
    const l1 = f.hunks[0]!.lines;
    expect(l1[0]).toMatchObject({ type: 'ctx', oldNo: 1, newNo: 1 });
    expect(l1[1]).toMatchObject({ type: 'del', oldNo: 2, newNo: null, text: 'old' });
    expect(l1[2]).toMatchObject({ type: 'add', oldNo: null, newNo: 2, text: 'new1' });
    expect(l1[3]).toMatchObject({ type: 'add', oldNo: null, newNo: 3, text: 'new2' });
    expect(f.hunks[1]!.lines[0]).toMatchObject({ type: 'ctx', oldNo: 10, newNo: 11 });
  });

  it('支持 CRLF 切行', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-a', '+b'].join('\r\n');
    const files = parseDiff(diff);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2);
    expect(files[0]!.hunks[0]!.lines[1]).toMatchObject({ type: 'add', text: 'b' });
  });

  it('识别重命名：status R 且保留 oldPath', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files[0]!.status).toBe('R');
    expect(files[0]!.path).toBe('new.ts');
    expect(files[0]!.oldPath).toBe('old.ts');
  });

  it('识别新增 / 删除 / 二进制', () => {
    const diff = [
      'diff --git a/add.ts b/add.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/add.ts',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files[0]).toMatchObject({ status: 'A', additions: 1, deletions: 0 });
    expect(files[1]).toMatchObject({ status: 'D' });
    expect(files[2]!.isBinary).toBe(true);
  });

  it('statsOf 汇总数字', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/b.py b/b.py',
      '--- a/b.py',
      '+++ b/b.py',
      '@@ -1 +1,2 @@',
      '-c',
      '+d',
      '+e',
    ].join('\n');
    const stats = statsOf(parseDiff(diff));
    expect(stats).toMatchObject({ files: 2, additions: 3, deletions: 2 });
    expect(stats.byExt.ts).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(stats.byExt.py).toEqual({ files: 1, additions: 2, deletions: 1 });
  });
});
