/** 全项目可预期失败的统一错误码 */
export const ERROR_CODES = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  NO_API_KEY: 'NO_API_KEY',
  NOT_A_REPO: 'NOT_A_REPO',
  REF_NOT_FOUND: 'REF_NOT_FOUND',
  GIT_FAILED: 'GIT_FAILED',
  NO_DATA: 'NO_DATA',
  LLM_FAILED: 'LLM_FAILED',
  LLM_SCHEMA_INVALID: 'LLM_SCHEMA_INVALID',
  FS_FAILED: 'FS_FAILED',
  HOOK_FAILED: 'HOOK_FAILED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * 全项目唯一的可预期失败类型。
 * 底层（git/fs/llm）只抛错，不打印、不 process.exit。
 */
export class GitAgentError extends Error {
  readonly code: ErrorCode;
  /** 给用户的可执行提示，如「在 ~/.git-agent/.env 中配置 DEEPSEEK_API_KEY」 */
  readonly hint?: string;
  /** 结构化上下文（zod issues、原始错误等），仅用于 -v 排查 */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, hint?: string, details?: unknown) {
    super(message);
    this.name = 'GitAgentError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
    if (details !== undefined) this.details = details;
    // 继承 Error 时修正原型链（target ES2022 下 class 语法本就正确，保留以防降级编译）
    Object.setPrototypeOf(this, GitAgentError.prototype);
  }

  /** 终端友好文本：message + hint 一行 */
  toDisplayString(): string {
    return this.hint ? `${this.message}\n  → ${this.hint}` : this.message;
  }
}

/** 类型守卫：判断未知异常是否是 GitAgentError */
export function isGitAgentError(e: unknown): e is GitAgentError {
  return e instanceof GitAgentError;
}

/** 把未知异常包成 GitAgentError，便于统一按 code 分支处理 */
export function toGitAgentError(e: unknown, fallback: ErrorCode = 'GIT_FAILED'): GitAgentError {
  if (isGitAgentError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new GitAgentError(fallback, message, undefined, e);
}
