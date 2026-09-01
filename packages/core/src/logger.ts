import type { LogLevel, Logger } from './types.js';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** 日志是否启用该级别 */
function enabled(current: LogLevel, target: Exclude<LogLevel, 'silent'>): boolean {
  return ORDER[current] >= ORDER[target];
}

/**
 * 创建分级日志器。日志一律写 stderr（console.error），
 * stdout 留给报告全文与 JSON 输出。
 */
export function createLogger(level: LogLevel = 'info', prefix = ''): Logger {
  const emit = (target: Exclude<LogLevel, 'silent'>, m: string): void => {
    if (!enabled(level, target)) return;
    const tag = target.toUpperCase().padEnd(5);
    const head = prefix ? `[${tag}] ${prefix}` : `[${tag}]`;
    console.error(`${head} ${m}`);
  };

  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    child: (childPrefix) => createLogger(level, prefix ? `${prefix}:${childPrefix}` : childPrefix),
  };
}

/** 什么都不做的日志器，供单测与静默场景使用 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
