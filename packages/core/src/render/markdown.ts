/** Markdown 片段助手：标题、表格、严重度图标 */

/** 生成 ATX 标题；level 夹在 1-6 */
export function mdHeading(level: number, text: string): string {
  const n = Math.min(6, Math.max(1, Math.floor(level) || 1));
  return `${'#'.repeat(n)} ${text}`;
}

/** 表格单元格转义：竖线与换行 */
function cell(s: string): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 生成管道表格；rows 为空时返回空串 */
export function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((x) => cell(x)).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

const SEVERITY_ICONS: Record<string, string> = {
  blocker: '⛔ 阻断',
  major: '⚠️ 重要',
  minor: '✦ 建议',
  nit: '· 吹毛求疵',
};

/** review 严重度 → 图标标签；未知值原样返回 */
export function severityIcon(severity: string): string {
  return SEVERITY_ICONS[severity] ?? severity;
}

/** 列表项 */
export function mdList(items: string[]): string {
  return items.filter((s) => s && s.trim() !== '').map((s) => `- ${s}`).join('\n');
}
