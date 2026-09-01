/**
 * 把 packages/core/prompts/ 拷贝到 packages/core/dist/prompts/。
 * 纯 Node 实现，避免 Windows 上 cp -r 的行为差异。
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'packages/core/prompts');
const dest = resolve(root, 'packages/core/dist/prompts');

const exists = async (p) => !!(await stat(p).catch(() => null));

if (!(await exists(src))) {
  console.error(`[copy-assets] 源目录不存在，已跳过：${src}`);
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`[copy-assets] prompts -> ${dest}`);
