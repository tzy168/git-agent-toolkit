export interface ComposePromptOptions {
  /** feature 的 system.md */
  instructions: string;
  /** 团队 rules.md + 模块 context（稳定） */
  rules: string;
  /** JSON Schema 文本（稳定） */
  schema: string;
  /** 稳定 */
  fewShot?: string;
  /** ★ 易变内容（diff / log / note）—— 永远放在 user 末尾 */
  variable: string;
}

export interface ComposedPrompt {
  system: string;
  user: string;
}

const SECTION_SEP = '\n\n';

/**
 * 缓存友好布局：稳定内容全部进 system，易变内容独占 user 末尾。
 * 分片场景下调用方必须复用同一个 system 字符串，否则前缀缓存不命中。
 */
export function composePrompt(o: ComposePromptOptions): ComposedPrompt {
  const sections = [
    section('ROLE & INSTRUCTIONS', o.instructions),
    section('RULES & CONTEXT', o.rules),
    section('OUTPUT SCHEMA', o.schema),
  ];
  if (o.fewShot && o.fewShot.trim() !== '') {
    sections.push(section('EXAMPLES', o.fewShot));
  }
  return {
    system: sections.join(SECTION_SEP),
    user: o.variable,
  };
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return `## ${title}\n（无）`;
  return `## ${title}\n${trimmed}`;
}

/** 估算一份 prompt 的 token 数（与 llm/budget 同一套估算，避免重复实现） */
export function promptSize(p: ComposedPrompt, estimateTokens: (s: string) => number): {
  systemTokens: number;
  userTokens: number;
  totalTokens: number;
} {
  const systemTokens = estimateTokens(p.system);
  const userTokens = estimateTokens(p.user);
  return { systemTokens, userTokens, totalTokens: systemTokens + userTokens };
}
