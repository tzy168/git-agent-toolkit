import { buildContext, type CliOpts } from '../context.js';
import { EXIT } from '../exit.js';

/** git-agent cache stats|clear [ns]：缓存查看与清理 */
export async function cacheCommand(action: string, ns?: string): Promise<number> {
  const ctx = await buildContext({} as CliOpts);

  if (action === 'stats') {
    const s = await ctx.cache.stats();
    console.error(`缓存条目：${s.entries}，总大小：${(s.sizeBytes / 1024).toFixed(1)} KB`);
    console.error(`位置：${ctx.cache.root}`);
    return EXIT.OK;
  }
  if (action === 'clear') {
    if (ns !== undefined && !['collect', 'result'].includes(ns)) {
      console.error(`未知命名空间：${ns}（可用：collect / result / 不给 = 全部）`);
      return EXIT.ERR;
    }
    const removed = await ctx.cache.clear(ns);
    console.error(`✓ 已清理 ${removed} 条缓存${ns ? `（${ns}）` : ''}`);
    return EXIT.OK;
  }
  console.error(`未知子命令：cache ${action}（可用：stats / clear [collect|result]）`);
  return EXIT.ERR;
}
