import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  formatCommitMessage,
  listFeatures,
  previewPrompts,
  resolveOutputPath,
  runPipeline,
  toJsonEnvelope,
  writeReport,
  printSummary,
  type CommitOutput,
  type Feature,
} from 'git-agent-core';

import { askCommand } from './commands/ask.js';
import { cacheCommand } from './commands/cache.js';
import { configCommand } from './commands/config.js';
import { hooksCommand } from './commands/hooks.js';
import { buildContext, ensureApiKey, type CliOpts } from './context.js';
import { EXIT } from './exit.js';
import { editInEditor, selectOne } from './interactive.js';

/** 给 program 挂全局选项，按 registry 生成子命令，再挂 config/hooks/cache/ask */
export function registerCommands(program: Command): void {
  program
    .option('--base <ref>', '对比基线')
    .option('--head <ref>', '对比头')
    .option('--out <path>', '报告 / 钩子提交信息输出路径')
    .option('--stdout', '把全文打到 stdout')
    .option('--json', 'JSON 输出')
    .option('--dry-run', '只打印 prompt，不调 API')
    .option('--cache', '启用采集/结果缓存（默认关闭）')
    .option('--no-cache', '禁用缓存（覆盖配置）')
    .option('--model <id>', '覆盖本次使用的模型 id')
    .option('-v, --verbose', 'debug 日志')
    .option('--quiet', '静默');

  for (const feature of listFeatures()) {
    const cmd = program.command(feature.id).description(feature.description);
    for (const p of feature.params) cmd.option(p.flag, p.description);
    cmd.action(async () => {
      const opts = cmd.optsWithGlobals() as CliOpts;
      try {
        process.exitCode = await runFeature(feature, opts);
      } catch (e) {
        if (opts.prefill) {
          console.error(`[debug] commit --prefill 忽略错误：${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = EXIT.OK;
          return;
        }
        throw e;
      }
    });
  }

  program
    .command('config')
    .description('管理配置文件（init：生成 .git-agent/config.yml 与模板）')
    .argument('<action>', 'init')
    .option('--force', '覆盖已存在的文件')
    .action(async (action: string, opts: { force?: boolean }) => {
      process.exitCode = await configCommand(action, opts);
    });

  program
    .command('hooks')
    .description('安装 / 卸载 prepare-commit-msg 钩子（install / uninstall）')
    .argument('<action>', 'install | uninstall')
    .action(async (action: string) => {
      process.exitCode = await hooksCommand(action);
    });

  program
    .command('cache')
    .description('缓存管理（stats / clear [collect|result]）')
    .argument('<action>', 'stats | clear')
    .argument('[ns]', 'collect | result')
    .action(async (action: string, ns?: string) => {
      process.exitCode = await cacheCommand(action, ns);
    });

  program
    .command('ask')
    .description('自然语言入口：描述需求，由模型挑命令并确认后执行')
    .argument('<query...>', '需求描述')
    .action(async (query: string[]) => {
      process.exitCode = await askCommand(query.join(' '), program);
    });
}

async function runFeature(feature: Feature, opts: CliOpts): Promise<number> {
  if (feature.id === 'weekly' && opts.edit) {
    opts.note = opts.note ?? (await editInEditor('（在这里写下本周人工补充，保存退出）'));
  }

  const ctx = await buildContext(opts);
  ctx.onProgress({ phase: 'collect', message: `采集 ${feature.id}` });
  const data = await feature.collect(ctx, opts);

  if (opts.dryRun) {
    for (const p of previewPrompts(feature, data, ctx)) {
      console.log(`--- ${feature.id}/${p.id} system ---\n${p.system}\n--- user ---\n${p.user}\n`);
    }
    return EXIT.OK;
  }

  if (!opts.prefill) await ensureApiKey(ctx.logger);

  const result = await runPipeline(feature, data, ctx);
  await ctx.cache.write('result', `${feature.id}:${data.fingerprint}`, result.output);

  if (feature.id === 'commit') {
    return finishCommit(result.output as CommitOutput, ctx, opts);
  }
  return finishReport(feature, result.output, result.usage, ctx, opts, data);
}

/** 渲染 + 落盘 + 摘要 + 退出码；--json 走结构化输出 */
async function finishReport(
  feature: Feature,
  output: unknown,
  usage: import('git-agent-core').UsageTotals,
  ctx: Awaited<ReturnType<typeof buildContext>>,
  opts: CliOpts,
  data: import('git-agent-core').CollectedData,
): Promise<number> {
  const md = feature.render(output, ctx, data);
  const outPath = resolveOutputPath(ctx.config, ctx.config.repoRoot, feature.id, { out: opts.out, branch: ctx.repo.branch });

  if (opts.json) {
    console.log(JSON.stringify(toJsonEnvelope(feature.id, output, data, usage), null, 2));
    if (opts.out) await writeReport(md, outPath); // --json 默认不写 md，除非给了 --out
  } else {
    await writeReport(md, outPath);
    printSummary(feature.summaryLine?.(output) ?? `✓ ${feature.name}完成`, outPath);
    if (opts.stdout) console.log(md);
  }
  return feature.exitCode?.(output) ?? EXIT.OK;
}

async function finishCommit(output: CommitOutput, ctx: Awaited<ReturnType<typeof buildContext>>, opts: CliOpts): Promise<number> {
  if (output.candidates.length === 0) return EXIT.NO_DATA;
  if (output.splitHint) ctx.logger.warn(`拆分建议：${output.splitHint}`);

  if (opts.prefill) {
    const msg = formatCommitMessage(output.candidates[0]!);
    if (opts.out) await writeFile(path.resolve(opts.out), `${msg}\n`, 'utf8');
    else console.log(msg);
    return EXIT.OK;
  }

  const labels = output.candidates.map((c, i) => `${i + 1}. ${formatCommitMessage(c).split('\n')[0]}`);
  labels.push('e  编辑', 'n  取消');
  const pick = await selectOne('选一个提交信息（序号 / e / n）', labels);

  if (pick === null || pick === 'n' || pick === 'N') {
    ctx.logger.info('已取消');
    return EXIT.NO_DATA;
  }

  let message: string;
  if (pick === 'e' || pick === 'E') {
    message = await editInEditor(formatCommitMessage(output.candidates[0]!));
    if (!message) return EXIT.NO_DATA;
  } else {
    const cand = output.candidates[Number(pick) - 1];
    if (!cand) {
      ctx.logger.error('无效序号');
      return EXIT.ERR;
    }
    message = formatCommitMessage(cand);
  }

  await ctx.git.commit(message);
  ctx.logger.info(`已提交：${message.split('\n')[0]}`);
  return EXIT.OK;
}
