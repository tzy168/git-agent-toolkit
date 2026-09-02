import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasApiKey, mergeConfigs, saveGlobalApiKey, upsertEnvLine } from '../../src/config/loader.js';

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

describe('upsertEnvLine / hasApiKey', () => {
  it('空文件写入一行并补 LF', () => {
    expect(upsertEnvLine('', 'DEEPSEEK_API_KEY', 'sk-abc')).toBe('DEEPSEEK_API_KEY=sk-abc\n');
  });

  it('保留其他行，追加 Key', () => {
    const next = upsertEnvLine('FOO=1\n', 'DEEPSEEK_API_KEY', 'sk-abc');
    expect(next).toBe('FOO=1\nDEEPSEEK_API_KEY=sk-abc\n');
  });

  it('替换已有 Key，不重复追加', () => {
    const next = upsertEnvLine('FOO=1\nDEEPSEEK_API_KEY=old\nBAR=2\n', 'DEEPSEEK_API_KEY', 'sk-new');
    expect(next).toBe('FOO=1\nDEEPSEEK_API_KEY=sk-new\nBAR=2\n');
  });

  it('CRLF 归一为 LF 后再替换', () => {
    const next = upsertEnvLine('FOO=1\r\nDEEPSEEK_API_KEY=old\r\n', 'DEEPSEEK_API_KEY', 'sk-new');
    expect(next).toBe('FOO=1\nDEEPSEEK_API_KEY=sk-new\n');
  });

  it('value 含 $ 时不当成 replace 分组', () => {
    expect(upsertEnvLine('DEEPSEEK_API_KEY=old\n', 'DEEPSEEK_API_KEY', 'sk-$abc')).toBe(
      'DEEPSEEK_API_KEY=sk-$abc\n',
    );
  });

  it('hasApiKey：空串和空白视为无 Key', () => {
    expect(hasApiKey({})).toBe(false);
    expect(hasApiKey({ DEEPSEEK_API_KEY: '' })).toBe(false);
    expect(hasApiKey({ DEEPSEEK_API_KEY: '  ' })).toBe(false);
    expect(hasApiKey({ DEEPSEEK_API_KEY: 'sk-x' })).toBe(true);
  });

  it('saveGlobalApiKey 写入临时 home 并设置 process.env', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'gat-env-'));
    const prev = process.env.DEEPSEEK_API_KEY;
    try {
      const file = await saveGlobalApiKey('sk-tmp', home);
      expect(file).toBe(path.join(home, '.git-agent', '.env'));
      expect(await readFile(file, 'utf8')).toBe('DEEPSEEK_API_KEY=sk-tmp\n');
      expect(process.env.DEEPSEEK_API_KEY).toBe('sk-tmp');
      await saveGlobalApiKey('sk-next', home);
      expect(await readFile(file, 'utf8')).toBe('DEEPSEEK_API_KEY=sk-next\n');
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prev;
    }
  });
});
