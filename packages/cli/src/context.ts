import {
  createDiskCache,
  createGitProvider,
  createLLMProvider,
  createLogger,
  createRedactor,
  loadConfig,
  type FeatureContext,
  type GitAgentConfig,
  type LogLevel,
} from '@git-agent/core';

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
  if (opts.cache === false) cliOverrides.cache = { enabled: false };
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
