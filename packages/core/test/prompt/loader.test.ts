import { afterAll, describe, expect, it } from 'vitest';

import { applyVars, loadPrompt, loadShared, setPromptRoot } from '../../src/prompt/loader.js';

// 直接用仓库真实 prompts 目录（vitest 从 src 运行时 loader 能定位到 packages/core/prompts）
afterAll(() => setPromptRoot(null));

describe('applyVars', () => {
  it('替换已知变量，允许 {{ name }} 带空白', () => {
    expect(applyVars('a {{x}} b {{ y }}', { x: '1', y: '2' })).toBe('a 1 b 2');
  });

  it('未知变量原样保留', () => {
    expect(applyVars('{{known}} {{unknown}}', { known: 'v' })).toBe('v {{unknown}}');
  });

  it('值为空串时替换为空串；不传 vars 原样返回', () => {
    expect(applyVars('{{x}}!', { x: '' })).toBe('!');
    expect(applyVars('{{x}}')).toBe('{{x}}');
  });
});

describe('loadPrompt / loadShared（真实模板）', () => {
  it('能读到仓库里的模板并做变量替换', async () => {
    const text = await loadPrompt('review/chunk', { module: 'src/core', diff: '+hello', context: '（无）' });
    expect(text).toContain('src/core');
    expect(text).toContain('+hello');
  });

  it('shared 片段按顺序拼接且非空', async () => {
    const text = await loadShared('anti-hallucination', 'output-format');
    expect(text).toMatch(/\S/);
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });
});
