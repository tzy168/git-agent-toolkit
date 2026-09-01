import picomatch from 'picomatch';

import type { ResolvedConfig } from '../config/types.js';
import type { FileChange } from '../types.js';
import { toPosix } from '../paths.js';
import type { Logger } from '../types.js';
import { EMAIL_RULE, REDACT_RULES } from './rules.js';
import type { RedactRule } from './rules.js';

export interface Redactor {
  readonly enabled: boolean;
  /** 对文本应用全部脱敏规则 */
  redact(text: string): string;
  /** 路径是否被整体阻断（命中 blockedPaths） */
  isBlocked(path: string): boolean;
  /** 实际生效的阻断 glob */
  readonly blockedPatterns: string[];
}

/** 脱敏计数，用于报告「说明」段与 -v 日志 */
export interface RedactReport {
  hits: Record<string, number>;
  total: number;
}

const EMPTY_REPORT: RedactReport = { hits: {}, total: 0 };

/** 按配置创建脱敏器 */
export function createRedactor(cfg: ResolvedConfig, logger?: Logger): Redactor {
  const enabled = cfg.security.redact;
  const blockedPatterns = [...cfg.security.blockedPaths];
  const isBlockedPath = picomatch(blockedPatterns, { dot: true });

  const rules: RedactRule[] = enabled ? [...REDACT_RULES] : [];
  if (enabled && cfg.security.redactEmails) rules.push(EMAIL_RULE);

  return {
    enabled,
    blockedPatterns,
    redact(text) {
      if (!enabled || text === '') return text;
      let out = text;
      for (const rule of rules) {
        // 规则是模块级常量，lastIndex 由 g 标志维护，重置一次避免跨调用污染
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, rule.replacement);
      }
      return out;
    },
    isBlocked(p) {
      if (!enabled) return false;
      const posix = toPosix(p);
      try {
        return isBlockedPath(posix);
      } catch (e) {
        logger?.warn(`路径黑名单匹配失败，按未命中处理：${posix}（${String(e)}）`);
        return false;
      }
    },
  };
}

/** 统计文本里各规则的命中次数（用于 -v 与报告说明段，不修改文本） */
export function scanRedactHits(text: string, cfg: ResolvedConfig): RedactReport {
  if (!cfg.security.redact || text === '') return EMPTY_REPORT;
  const rules = cfg.security.redactEmails ? [...REDACT_RULES, EMAIL_RULE] : REDACT_RULES;
  const hits: Record<string, number> = {};
  let total = 0;
  for (const rule of rules) {
    const m = text.match(new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`));
    if (m && m.length > 0) {
      hits[rule.id] = m.length;
      total += m.length;
    }
  }
  return { hits, total };
}

/** 就地脱敏 diff 的每一行文本（采集后写缓存前调用，保证缓存里也是脱敏内容） */
export function redactFiles(files: FileChange[], redactor: Redactor): FileChange[] {
  if (!redactor.enabled) return files;
  return files.map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line, text: redactor.redact(line.text) })),
    })),
  }));
}
