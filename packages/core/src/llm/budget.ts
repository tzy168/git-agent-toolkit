import { countLines } from '../util/text.js';

/**
 * token 粗估。只用于分级与分片，宁可高估：
 * 高估只是多分几片，低估会超出预算。
 * ASCII 约 4 字符/token，CJK 约 1.5 字符/token，另加行开销。
 */
export function estimateTokens(s: string): number {
  if (s === '') return 0;
  const cjk = (s.match(/[一-鿿　-〿]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.5 + countLines(s) * 0.5);
}

/** 是否在预算内（maxTokens 为总预算硬闸） */
export function withinBudget(tokens: number, maxTokens: number): boolean {
  return tokens <= maxTokens;
}

/** 剩余预算（不会小于 0） */
export function remainingBudget(usedTokens: number, maxTokens: number): number {
  return Math.max(0, maxTokens - usedTokens);
}

/** 是否为 hunks 边界行（unified diff 的 @@ 头） */
function isHunkHeader(line: string): boolean {
  return line.startsWith('@@');
}

/** 是否为 diff 文件头行 */
function isFileHeader(line: string): boolean {
  return line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ');
}

/**
 * 按 hunk 边界安全截断文本，保证不切断行、不切断 hunk。
 * 若第一个 hunk 就超预算，则退化为按行截断（并追加截断说明）。
 */
export function truncateToBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  let cutAtHunkBoundary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > maxTokens) {
      // 只在 hunk 边界或文件头处收刀，保证语义完整
      cutAtHunkBoundary = isHunkHeader(line) || isFileHeader(line);
      break;
    }
    used += cost;
    kept.push(line);
  }

  if (kept.length === 0) {
    // 单行就超预算：按字符硬截，保证不返回空串
    const perChar = maxTokens * 3;
    return `${text.slice(0, Math.max(0, perChar))}\n…（已按预算截断）`;
  }

  if (!cutAtHunkBoundary) {
    return `${kept.join('\n')}\n…（已按预算截断）`;
  }
  return kept.join('\n');
}
