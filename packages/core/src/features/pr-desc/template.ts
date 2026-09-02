import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadPrompt } from '../../prompt/loader.js';
import type { ResolvedConfig } from '../../config/types.js';
import type { GitProvider } from '../../git/types.js';

export interface PrTemplate {
  /** 模板里的章节标题（按出现顺序） */
  headings: string[];
  /** 模板来源：命中的路径或 'builtin' */
  source: string;
  /** 原始模板文本（渲染时放在报告开头） */
  raw: string;
}

/**
 * 按序探测仓库 PR 模板（config.prDesc.templatePaths），
 * 都没有则用内置默认（prompts/pr-desc/default-template.md）。
 * .git/ 下的模板不被跟踪 → 直接 fs 读；其余先 fs 后 HEAD。
 */
export async function resolvePrTemplate(git: GitProvider, cfg: ResolvedConfig): Promise<PrTemplate> {
  const repo = await git.getRepoInfo();
  for (const rel of cfg.prDesc.templatePaths) {
    const text = await readTemplate(git, repo.root, rel);
    if (text) {
      return { headings: extractHeadings(text), source: rel, raw: text };
    }
  }
  const builtin = await loadPrompt('pr-desc/default-template');
  return { headings: extractHeadings(builtin), source: 'builtin', raw: builtin };
}

async function readTemplate(git: GitProvider, root: string, rel: string): Promise<string | null> {
  const abs = path.resolve(root, rel);
  try {
    const text = await readFile(abs, 'utf8');
    if (text.trim() !== '') return text;
  } catch {
    // 落到 HEAD 读取
  }
  try {
    const text = await git.getFileAt('HEAD', rel);
    if (text && text.trim() !== '') return text;
  } catch {
    // 忽略
  }
  return null;
}

/** 提取 markdown 的 ## / # 标题作为章节（# 一级标题跳过，视为文档题目） */
export function extractHeadings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (m?.[2]) out.push(m[2]);
  }
  return out;
}
