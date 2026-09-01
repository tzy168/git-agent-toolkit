import { z } from 'zod';

import { DEFAULT_CONFIG } from './defaults.js';

/* ------------------------------------------------------------------ */
/* 各节 schema：全部 partial，逐字段校验用户手写的 yml                    */
/* ------------------------------------------------------------------ */

const GitSection = z
  .object({
    defaultBase: z.string().min(1),
    includeAuthors: z.array(z.string()),
  })
  .partial();

const ReviewSection = z
  .object({
    ignorePaths: z.array(z.string()),
    focusDimensions: z.array(z.string()),
    contextPaths: z.array(z.string()),
  })
  .partial();

const TestPlanSection = z
  .object({
    priorityLevels: z.array(z.enum(['P0', 'P1', 'P2'])),
    detectExisting: z.boolean(),
    focus: z.array(z.string()),
  })
  .partial();

const ImpactSection = z
  .object({
    maxDepth: z.number().int().min(1).max(2),
    symbolParser: z.enum(['ts-morph', 'grep']),
    includeTests: z.boolean(),
  })
  .partial();

const PrDescSection = z
  .object({
    templatePaths: z.array(z.string()),
    includeReviewSummary: z.boolean(),
  })
  .partial();

const CommitSection = z
  .object({
    convention: z.enum(['conventional', 'angular', 'custom']),
    types: z.array(z.string().min(1)),
    maxSubjectLength: z.number().int().min(10).max(200),
    learnFromLog: z.number().int().min(0).max(500),
    candidates: z.number().int().min(1).max(10),
    language: z.string().min(1),
    hooks: z
      .object({
        enabled: z.boolean(),
        skipEnvVar: z.string(),
      })
      .partial(),
  })
  .partial();

const LlmSection = z
  .object({
    provider: z.literal('deepseek'),
    model: z.object({ fast: z.string().min(1), strong: z.string().min(1) }).partial(),
    reasoningEffort: z.enum(['non-think', 'high', 'max']),
    maxInputTokens: z.number().int().positive(),
    chunkTargetTokens: z.number().int().positive(),
    concurrency: z.number().int().min(1).max(16),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0).max(5),
  })
  .partial();

const SecuritySection = z
  .object({
    redact: z.boolean(),
    redactEmails: z.boolean(),
    blockedPaths: z.array(z.string()),
  })
  .partial();

const OutputSection = z
  .object({
    dir: z.string(),
    format: z.enum(['markdown', 'html', 'json']),
    language: z.string(),
  })
  .partial();

const DiffSection = z
  .object({
    smallThresholdTokens: z.number().int().positive(),
    largeThresholdTokens: z.number().int().positive(),
    enrichThresholdLines: z.number().int().min(0),
    enrichMaxTokens: z.number().int().min(0),
  })
  .partial();

const CacheSection = z
  .object({
    enabled: z.boolean(),
    maxAgeDays: z.number().int().min(0),
    dir: z.string(),
  })
  .partial();

/** 用户配置 schema：所有字段可选 */
export const ConfigSchema = z
  .object({
    git: GitSection,
    review: ReviewSection,
    testPlan: TestPlanSection,
    impact: ImpactSection,
    prDesc: PrDescSection,
    commit: CommitSection,
    llm: LlmSection,
    security: SecuritySection,
    output: OutputSection,
    diff: DiffSection,
    cache: CacheSection,
  })
  .partial();

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

export type ConfigIssue = { path: string; message: string };
export type ValidateResult =
  | { ok: true; data: ValidatedConfig }
  | { ok: false; errors: ConfigIssue[] };

/** 把 zod issues 压成「a.b.c: message」形式，便于终端定位 */
function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): ConfigIssue[] {
  return issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
}

/** 找出用户写了但架构里不认识的键（拼错字段名时最常见的错误） */
function findUnknownKeys(raw: unknown, base = ''): ConfigIssue[] {
  if (Array.isArray(raw)) return [];
  if (raw === null || typeof raw !== 'object') return [];

  const template = base
    ? (base.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), DEFAULT_CONFIG) ?? null)
    : DEFAULT_CONFIG;

  if (template === null || typeof template !== 'object' || Array.isArray(template)) return [];

  const known = new Set(Object.keys(template as Record<string, unknown>));
  const out: ConfigIssue[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'version' || key === 'repoRoot' || key === 'configPaths') continue;
    const path = base ? `${base}.${key}` : key;
    if (!known.has(key)) {
      out.push({ path, message: `未知配置项（可选：${[...known].join(', ')}）` });
      continue;
    }
    out.push(...findUnknownKeys(value, path));
  }
  return out;
}

/** 校验用户配置，返回结构化错误而不是抛异常，便于一次性报全部问题 */
export function validateConfig(raw: unknown): ValidateResult {
  if (raw !== null && typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '', message: '配置文件必须是 YAML 对象' }] };
  }

  const unknown = findUnknownKeys(raw);
  const parsed = ConfigSchema.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, errors: [...unknown, ...formatIssues(parsed.error.issues)] };
  }
  if (unknown.length > 0) {
    return { ok: false, errors: unknown };
  }
  return { ok: true, data: parsed.data };
}
