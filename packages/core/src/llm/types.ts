/** 模型档位：fast / strong → cfg.llm.model.fast / .strong */
export type ModelTier = 'fast' | 'strong';
/** 思考模式：off 走普通模式，high / max 走思考模式 */
export type ThinkingMode = 'off' | 'high' | 'max';

export interface LLMRequest {
  /** 稳定前缀（rules + schema + few-shot） */
  system: string;
  /** 易变内容（diff / log / note）—— 永远放最后 */
  user: string;
  /** 默认 'fast' */
  tier?: ModelTier;
  /** 显式覆盖模型 id（--model） */
  model?: string;
  thinking?: ThinkingMode;
  maxOutputTokens?: number;
  /** z.toJSONSchema(schema) 的产物 */
  jsonSchema?: unknown;
  /** 仅用于日志与用量归因 */
  meta?: { featureId: string; stepId: string };
}

export interface LLMResponse {
  /** JSON 模式下的 JSON 字符串 */
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  };
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
  /** 实际使用的模型 id，用于 -v 打印 */
  readonly modelId: string;
}
