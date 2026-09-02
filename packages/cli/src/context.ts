import {
  createDiskCache,
  createGitProvider,
  createLLMProvider,
  createLogger,
  createRedactor,
  GitAgentError,
  hasApiKey,
  loadConfig,
  saveGlobalApiKey,
  type FeatureContext,
  type GitAgentConfig,
  type LogLevel,
  type Logger,
} from 'git-agent-core';

import { promptLine } from './interactive.js';

export interface CliOpts {
  base?: string;
  head?: string;
  out?: string;
  stdout?: boolean;
  json?: boolean;
  dryRun?: boolean;
  cache?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  model?: string;
  prefill?: boolean;
  lang?: string;
  since?: string;
  until?: string;
  note?: string;
  noteFile?: string;
  edit?: boolean;
  withReview?: boolean;
  authors?: string;
}

function logLevel(opts: CliOpts): LogLevel {
  if (opts.quiet) return 'silent';
  if (opts.verbose) return 'debug';
  return 'info';
}

/** 组装 FeatureContext：config → git → llm → logger → redactor → cache */
export async function buildContext(opts: CliOpts): Promise<FeatureContext> {
  const logger = createLogger(logLevel(opts));
  const cliOverrides: GitAgentConfig = {};
  if (opts.base) cliOverrides.git = { defaultBase: opts.base };
  if (opts.model) {
    cliOverrides.llm = { model: { fast: opts.model, strong: opts.model } };
  }
  if (typeof opts.cache === 'boolean') cliOverrides.cache = { enabled: opts.cache };
  if (opts.lang) cliOverrides.commit = { language: opts.lang };

  const config = await loadConfig({ cwd: process.cwd(), cliOverrides });
  const git = await createGitProvider(process.cwd());
  const repo = await git.getRepoInfo();
  config.repoRoot = repo.root;

  const redactor = createRedactor(config, logger);
  const cache = createDiskCache(repo.root, {
    enabled: config.cache.enabled,
    maxAgeDays: config.cache.maxAgeDays,
    dir: config.cache.dir,
    logger,
  });
  const llm = createLLMProvider(config, logger);

  return {
    repo,
    git,
    llm,
    config,
    logger,
    redactor,
    cache,
    dryRun: Boolean(opts.dryRun),
    modelOverride: opts.model,
    onProgress(e) {
      if (opts.quiet || !process.stderr.isTTY) return;
      const frac = e.current != null && e.total != null ? ` ${e.current}/${e.total}` : '';
      console.error(`⏳ ${e.message}${frac}`);
    },
  };
}

function normalizeApiKey(raw: string): string {
  let key = raw.trim().replace(/^['"]|['"]$/g, '');
  if (key.startsWith('DEEPSEEK_API_KEY=')) key = key.slice('DEEPSEEK_API_KEY='.length).trim();
  return key;
}

/** TTY 下缺 Key 时提示输入并写入 ~/.git-agent/.env；非 TTY 交给后续 LLM 抛 NO_API_KEY */
export async function ensureApiKey(logger?: Logger): Promise<void> {
  if (hasApiKey()) return;
  const raw = await promptLine(
    '未检测到 DEEPSEEK_API_KEY（https://platform.deepseek.com/）\n请输入 DeepSeek API Key: ',
  );
  const key = raw ? normalizeApiKey(raw) : '';
  if (!key) {
    throw new GitAgentError(
      'NO_API_KEY',
      '未检测到 DEEPSEEK_API_KEY',
      '在 ~/.git-agent/.env 或仓库 .env 中配置 DEEPSEEK_API_KEY',
    );
  }
  process.env.DEEPSEEK_API_KEY = key;
  try {
    const file = await saveGlobalApiKey(key);
    console.error(`✓ 已写入 ${file}，下次无需再输入`);
  } catch (e) {
    logger?.warn(`写入 ~/.git-agent/.env 失败，本次仍使用刚输入的 Key：${e instanceof Error ? e.message : String(e)}`);
  }
}
