import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  formatCommitMessage,
  listFeatures,
  previewPrompts,
  runPipeline,
  type CommitOutput,
  type Feature,
} from '@git-agent/core';

import { buildContext, type CliOpts } from './context.js';
import { EXIT } from './exit.js';
import { editInEditor, selectOne } from './interactive.js';

/** 给 program 挂上全局选项，并按 registry 生成子命令 */
export function registerCommands(program: Command): void {
  program
    .option('--base <ref>', '对比基线')
    .option('--head <ref>', '对比头')
    .option('--out <path>', '报告 / 钩子提交信息输出路径')
    .option('--stdout', '把全文打到 stdout')
    .option('--json', 'JSON 输出')
    .option('--dry-run', '只打印 prompt，不调 API')
    .option('--no-cache', '禁用缓存')
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
}

async function runFeature(feature: Feature, opts: CliOpts): Promise<number> {
  const ctx = await buildContext(opts);
  ctx.onProgress({ phase: 'collect', message: `采集 ${feature.id}` });
  const data = await feature.collect(ctx, {});

  if (opts.dryRun) {
    for (const p of previewPrompts(feature, data, ctx)) {
      console.log(`--- ${feature.id}/${p.id} system ---\n${p.system}\n--- user ---\n${p.user}\n`);
    }
    return EXIT.OK;
  }

  const result = await runPipeline(feature, data, ctx);

  if (feature.id === 'commit') {
    return finishCommit(result.output as CommitOutput, ctx, opts);
  }

  const md = feature.render(result.output, ctx, data);
  if (opts.json) {
    console.log(JSON.stringify({ feature: feature.id, output: result.output, usage: result.usage, stats: data.stats }, null, 2));
  } else if (opts.stdout) {
    console.log(md);
  }
  return feature.exitCode?.(result.output) ?? EXIT.OK;
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
