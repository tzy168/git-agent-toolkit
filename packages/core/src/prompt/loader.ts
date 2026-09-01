import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitAgentError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 进程内缓存：同一份 prompt 多次分片会重复读取，避免无谓 IO */
const cache = new Map<string, string>();

let rootOverride: string | null = null;

/**
 * 定位 prompts 根目录。
 * 构建后：`dist/prompt/loader.js` → `dist/prompts`
 * 开发时（tsx / vitest）：`src/prompt/loader.ts` → `packages/core/prompts`
 */
export function promptRoot(): string {
  if (rootOverride) return rootOverride;
  const candidates = [
    path.resolve(here, '..', 'prompts'),
    path.resolve(here, '..', '..', 'prompts'),
    path.resolve(here, '..', '..', '..', 'prompts'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new GitAgentError(
      'FS_FAILED',
      `未找到 prompts 目录，已尝试：${candidates.join(' | ')}`,
      '先执行 npm run build（会拷贝 packages/core/prompts 到 dist/prompts）',
    );
  }
  return found;
}

/** 单测或特殊场景下强制指定 prompts 根目录 */
export function setPromptRoot(dir: string | null): void {
  rootOverride = dir;
  cache.clear();
}

/** 清空进程内 prompt 缓存（改了 .md 后热重载用） */
export function clearPromptCache(): void {
  cache.clear();
}

/** 读取某个 prompt 文件的原始文本（不带变量替换） */
export async function readPromptFile(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const file = path.join(promptRoot(), `${name}.md`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new GitAgentError('FS_FAILED', `读取 prompt 失败：${file}`, '确认 prompts/ 下存在该文件或重新 npm run build', e);
  }
  cache.set(name, text);
  return text;
}

/** 把 {{var}} 替换成给定值；未知变量原样保留，便于排查拼写错误 */
export function applyVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? '' : whole,
  );
}

/** 把 {{shared:name}} 替换成 shared 片段内容 */
async function applyShared(text: string): Promise<string> {
  const matches = [...text.matchAll(/\{\{\s*shared:([\w.-]+)\s*\}\}/g)];
  if (matches.length === 0) return text;
  let out = text;
  for (const m of matches) {
    const shared = await readPromptFile(`shared/${m[1]}`);
    out = out.split(m[0]).join(shared);
  }
  return out;
}

/**
 * 加载一个 prompt 模板：`loadPrompt('review/chunk', {diff})`。
 * 支持 {{var}} 变量与 {{shared:name}} 片段注入。
 */
export async function loadPrompt(name: string, vars?: Record<string, string>): Promise<string> {
  const raw = await readPromptFile(name);
  return applyVars(await applyShared(raw), vars);
}

/** 加载若干 shared 片段并按顺序拼接（空行分隔） */
export async function loadShared(...names: string[]): Promise<string> {
  const parts = await Promise.all(names.map((n) => readPromptFile(`shared/${n}`)));
  return parts.join('\n\n');
}
