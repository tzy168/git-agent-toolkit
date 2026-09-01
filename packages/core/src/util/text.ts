/** CRLF / CR 归一为 LF */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** 按 `\r?\n` 切行，兼容 Windows 输出 */
export function splitLines(s: string): string[] {
  return s.split(/\r?\n/);
}

/** 统计行数（空字符串算 0 行） */
export function countLines(s: string): number {
  if (s === '') return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

/** 截断到前 n 行，超出部分追加提示行 */
export function truncateLines(s: string, n: number, notice = '…（已截断）'): string {
  const lines = splitLines(s);
  if (lines.length <= n) return s;
  return [...lines.slice(0, n), notice].join('\n');
}

/** 截断到前 n 个字符，超出部分追加省略号 */
export function truncateChars(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 稳定的字符串哈希（FNV-1a 32 位，十六进制），用于构造缓存指纹 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
