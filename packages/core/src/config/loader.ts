import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { load as loadYaml } from 'js-yaml';

import { GitAgentError } from '../errors.js';
import { absPosix } from '../paths.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { validateConfig } from './schema.js';
import type { GitAgentConfig, ResolvedConfig } from './types.js';

export interface LoadConfigOptions {
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 仓库根，默认取 cwd */
  repoRoot?: string;
  /** 全局配置根目录，默认 os.homedir()（单测可注入） */
  homeDir?: string;
  /** CLI 参数覆盖，优先级最高 */
  cliOverrides?: GitAgentConfig;
  /** 是否加载 .env 里的 DEEPSEEK_API_KEY，默认 true */
  loadEnv?: boolean;
}

/** 纯对象合并：数组整体替换，普通对象递归，undefined 跳过 */
export function mergeConfigs<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object') return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const prev = out[key];
    const bothPlain =
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value);
    out[key] = bothPlain ? mergeConfigs(prev, value) : value;
  }
  return out as T;
}

export const API_KEY_ENV = 'DEEPSEEK_API_KEY';

export function globalEnvPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.git-agent', '.env');
}

/** 进程环境里是否已有非空 DEEPSEEK_API_KEY */
export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[API_KEY_ENV]?.trim());
}

/** 在 .env 文本里写入或替换 KEY=value；保留其他行，统一 LF */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  const normalized = text.replace(/\r\n?/g, '\n');
  if (re.test(normalized)) return `${normalized.replace(re, () => line).replace(/\n*$/, '')}\n`;
  const body = normalized.replace(/\s*$/, '');
  return body ? `${body}\n${line}\n` : `${line}\n`;
}

/** 把 DEEPSEEK_API_KEY 写入 ~/.git-agent/.env，并写入当前进程环境 */
export async function saveGlobalApiKey(key: string, homeDir: string = os.homedir()): Promise<string> {
  const dir = path.join(homeDir, '.git-agent');
  const file = globalEnvPath(homeDir);
  await mkdir(dir, { recursive: true });
  let prev = '';
  try {
    prev = await readFile(file, 'utf8');
  } catch {
    // 文件不存在当空文件
  }
  await writeFile(file, upsertEnvLine(prev, API_KEY_ENV, key), 'utf8');
  if (process.platform !== 'win32') {
    try {
      await chmod(file, 0o600);
    } catch {
      // 无 chmod 权限时忽略
    }
  }
  process.env[API_KEY_ENV] = key;
  return file;
}

/** 载入 DEEPSEEK_API_KEY：全局 ~/.git-agent/.env 优先，仓库 .env 补充，都不覆盖已有环境变量 */
export function loadEnvFiles(homeDir: string, repoRoot: string): void {
  for (const file of [globalEnvPath(homeDir), path.join(repoRoot, '.env')]) {
    loadDotenv({ path: file, override: false, quiet: true });
  }
}

/** 读取并校验一层 yml；文件不存在返回 null，内容非法抛 CONFIG_INVALID */
async function readLayer(file: string): Promise<GitAgentConfig | null> {
  let rawText: string;
  try {
    rawText = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = loadYaml(rawText);
  } catch (e) {
    throw new GitAgentError(
      'CONFIG_INVALID',
      `配置文件不是合法 YAML：${file}`,
      '检查缩进与冒号后是否缺空格',
      e,
    );
  }
  if (raw === null || raw === undefined) return null;

  const result = validateConfig(raw);
  if (!result.ok) {
    const detail = result.errors.map((e) => `  · ${e.path || '(root)'}: ${e.message}`).join('\n');
    throw new GitAgentError('CONFIG_INVALID', `配置校验失败：${file}\n${detail}`, '对照 README 的配置项修正后重试', result.errors);
  }
  return result.data;
}

/**
 * 四层合并加载配置：defaults → 全局 → 仓库 → CLI 覆盖。
 * 读不到 DEEPSEEK_API_KEY 不报错（config init 等命令不需要 Key），
 * 到 LLM 首次调用时才抛 NO_API_KEY。
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = absPosix(opts.repoRoot ?? cwd);
  const homeDir = opts.homeDir ?? os.homedir();

  if (opts.loadEnv !== false) loadEnvFiles(homeDir, repoRoot);

  const globalFile = path.join(homeDir, '.git-agent', 'config.yml');
  const repoFile = path.join(repoRoot, '.git-agent', 'config.yml');

  const configPaths: string[] = [];
  let merged: ResolvedConfig = mergeConfigs(DEFAULT_CONFIG, {});

  for (const file of [globalFile, repoFile]) {
    const layer = await readLayer(file);
    if (layer) {
      merged = mergeConfigs(merged, layer);
      configPaths.push(absPosix(file));
    }
  }

  if (opts.cliOverrides) merged = mergeConfigs(merged, opts.cliOverrides);

  merged.repoRoot = repoRoot;
  merged.configPaths = configPaths;
  return merged;
}
