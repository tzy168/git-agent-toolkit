export { createDeepSeekProvider } from './deepseek.js';
export { estimateTokens, remainingBudget, truncateToBudget, withinBudget } from './budget.js';
export { isRetryableError, withRetry } from './retry.js';
export type { LLMProvider, LLMRequest, LLMResponse, ModelTier, ThinkingMode } from './types.js';

import type { ResolvedConfig } from '../config/types.js';
import type { Logger } from '../types.js';
import { createDeepSeekProvider } from './deepseek.js';
import type { LLMProvider } from './types.js';

/** 按 cfg.llm.provider 建 provider；无 Key 时也能建成 */
export function createLLMProvider(cfg: ResolvedConfig, logger?: Logger): LLMProvider {
  return createDeepSeekProvider(cfg, logger);
}
