import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CollectedData } from '../../types.js';
import type { FeatureContext } from '../registry.js';

/** 拼一份 diff 正文；给了 chunkId 则只取该片 */
export function blockDiff(data: CollectedData, chunkId?: string): string {
  if (chunkId) return data.chunks.find((c) => c.id === chunkId)?.text ?? '';
  return data.diffText;
}

/** commit 列表，给 weekly / review */
export function blockCommits(data: CollectedData): string {
  if (data.commits.length === 0) return '（无 commit）';
  return data.commits
    .map((c) => `- ${c.shortSha} ${c.subject} (${c.author}, ${c.date.slice(0, 10)})`)
    .join('\n');
}

/** 真实统计数字，禁止让模型自己算 */
export function blockStats(data: CollectedData): string {
  const s = data.stats;
  return `files=${s.files}  +${s.additions}  -${s.deletions}`;
}

/** 读 ~/.git-agent/rules.md + 仓库 .git-agent/context/*.md，缺文件当空 */
export async function blockTeamRules(ctx: FeatureContext): Promise<string> {
  const files = [
    path.join(os.homedir(), '.git-agent', 'rules.md'),
    path.join(ctx.config.repoRoot, '.git-agent', 'rules.md'),
  ];
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(await readFile(file, 'utf8'));
    } catch {
      // 没有规则文件是常态
    }
  }
  return parts.join('\n\n').trim();
}

/** 模块 context 目录下的 md，失败忽略 */
export async function blockModuleContext(ctx: FeatureContext): Promise<string> {
  const parts: string[] = [];
  for (const rel of ctx.config.review.contextPaths) {
    const dir = path.resolve(ctx.config.repoRoot, rel);
    try {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir(dir);
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        try {
          parts.push(await readFile(path.join(dir, name), 'utf8'));
        } catch {
          // skip
        }
      }
    } catch {
      // 目录不存在
    }
  }
  return parts.join('\n\n').trim();
}
