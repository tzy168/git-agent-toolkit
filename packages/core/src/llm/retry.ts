import { sleep } from '../util/async.js';

export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 2 */
  retries?: number;
  /** 初始退避，指数增长：800 → 1600 → 3200 */
  baseDelayMs?: number;
  /** 判断是否值得重试 */
  shouldRetry?: (e: unknown, attempt: number) => boolean;
  /** 每次重试前回调，用于打日志 */
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

interface HttpLikeError {
  status?: number;
  code?: string;
}

/** 429 / 5xx / 连接类错误才重试；业务错误（400 参数错）直接抛 */
export function isRetryableError(e: unknown): boolean {
  const err = e as HttpLikeError | null;
  if (!err || typeof err !== 'object') return false;

  const status = typeof err.status === 'number' ? err.status : 0;
  if (status === 408 || status === 409 || status === 429) return true;
  if (status >= 500) return true;

  const code = typeof err.code === 'string' ? err.code : '';
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

/**
 * 带指数退避的重试。刻意不做熔断状态机 —— 个人工具不需要。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const shouldRetry = opts.shouldRetry ?? isRetryableError;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !shouldRetry(e, attempt)) throw e;
      const delayMs = baseDelayMs * 2 ** attempt;
      opts.onRetry?.(e, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
