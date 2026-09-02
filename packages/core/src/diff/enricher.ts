import { estimateTokens } from '../llm/budget.js';
import type { ResolvedConfig } from '../config/types.js';
import type { GitProvider } from '../git/types.js';
import type { EnrichmentMap, FileChange } from '../types.js';
import { isGeneratedPath } from './parser.js';

export interface EnricherOptions {
  /** 补全片段总量上限（tokens 粗估） */
  maxTokens: number;
}

export interface Enricher {
  /** path → 追加给模型的 markdown 片段（带文件头与行号） */
  enrich(files: FileChange[], opts: EnricherOptions): Promise<EnrichmentMap>;
  /** 实际生效的模式，写进 CollectedData.degraded */
  readonly mode: 'ts-morph' | 'regex';
}

interface Block {
  name: string;
  startLine: number; // 1-based
  endLine: number;
  text: string;
}

const DECL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

/**
 * 上下文补全：为改动行数超过阈值的文件抓取被改函数完整定义 + 调用方。
 * ts-morph 懒加载，缺席自动降级为正则（大括号配平）。
 */
export async function createEnricher(git: GitProvider, cfg: ResolvedConfig): Promise<Enricher> {
  let morph: typeof import('ts-morph') | null = null;
  try {
    morph = (await import('ts-morph')) as typeof import('ts-morph');
  } catch {
    morph = null; // optionalDependencies 未装 → 正则降级
  }
  const mode: 'ts-morph' | 'regex' = morph ? 'ts-morph' : 'regex';

  return {
    mode,

    async enrich(files, opts) {
      const map: EnrichmentMap = {};
      let used = 0;
      const candidates = files
        .filter((f) => !f.isBinary && !isGeneratedPath(f.path) && f.status !== 'D' && f.status !== 'A')
        .filter((f) => f.additions + f.deletions > cfg.diff.enrichThresholdLines)
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

      for (const file of candidates) {
        if (used >= opts.maxTokens) break;
        try {
          const headText = await git.getFileAt('HEAD', file.path);
          if (!headText) continue;
          const changed = changedNewLines(file);
          if (changed.length === 0) continue;

          const blocks = mode === 'ts-morph' && morph
            ? blocksViaTsMorph(morph, headText, changed)
            : blocksViaRegex(headText, changed);
          if (blocks.length === 0) continue;

          const callers = await findCallers(git, blocks.map((b) => b.name), file.path);
          const snippet = renderSnippet(file.path, blocks, callers);
          const tokens = estimateTokens(snippet);
          if (used + tokens > opts.maxTokens) break;
          map[file.path] = snippet;
          used += tokens;
        } catch {
          // 单文件补全失败只跳过该文件，不中断
        }
      }
      return map;
    },
  };
}

/** 该文件被改的新侧行号（去重升序） */
function changedNewLines(file: FileChange): number[] {
  const set = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' && l.newNo != null) set.add(l.newNo);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function blocksViaTsMorph(morph: typeof import('ts-morph'), text: string, changed: number[]): Block[] {
  const project = new morph.Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('virtual.ts', text);
  const out = new Map<string, Block>();
  for (const line of changed) {
    const pos = lineStart(text, line - 1);
    let node = pos < sf.getEnd() ? sf.getDescendantAtPos(Math.max(pos, sf.getStart())) : undefined;
    while (node) {
      const kind = node.getKind();
      if (
        kind === morph.SyntaxKind.FunctionDeclaration ||
        kind === morph.SyntaxKind.ClassDeclaration ||
        kind === morph.SyntaxKind.InterfaceDeclaration ||
        kind === morph.SyntaxKind.TypeAliasDeclaration ||
        kind === morph.SyntaxKind.EnumDeclaration
      ) {
        const name = (node as { getName?: () => string }).getName?.() ?? '(anonymous)';
        out.set(name, {
          name,
          startLine: node.getStartLineNumber(),
          endLine: node.getEndLineNumber(),
          text: node.getText(),
        });
        break;
      }
      node = node.getParent();
    }
  }
  return [...out.values()];
}

/** 第 zeroBased 行（0-based）在原文中的起始偏移，兼容 \r\n */
function lineStart(text: string, zeroBased: number): number {
  let pos = 0;
  for (let i = 0; i < zeroBased; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) return text.length;
    pos = nl + 1;
  }
  return pos;
}

function blocksViaRegex(text: string, changed: number[]): Block[] {
  const lines = text.split(/\r?\n/);
  const decls: { name: string; start: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] as string).match(DECL_RE);
    if (!m) continue;
    decls.push({ name: m[2] ?? m[3] ?? '', start: i });
  }
  const out = new Map<string, Block>();
  for (const line of changed) {
    const idx = line - 1;
    // 找到覆盖该行的声明：start <= idx，且大括号配平后 end >= idx
    for (let d = decls.length - 1; d >= 0; d--) {
      const decl = decls[d] as { name: string; start: number };
      if (decl.start > idx) continue;
      const end = braceEnd(lines, decl.start, idx);
      if (end < idx) continue; // 该行落在声明块之外
      if (out.has(decl.name)) break;
      out.set(decl.name, {
        name: decl.name,
        startLine: decl.start + 1,
        endLine: Math.min(end + 1, lines.length),
        text: lines.slice(decl.start, end + 1).join('\n'),
      });
      break;
    }
  }
  return [...out.values()];
}

/** 从 from 行起做大括号配平，返回闭合行号；到 capLine 仍未闭合则返回 capLine */
function braceEnd(lines: string[], from: number, capLine: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i <= capLine && i < lines.length; i++) {
    for (const ch of lines[i] as string) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
  }
  return capLine;
}

async function findCallers(git: GitProvider, names: string[], selfPath: string): Promise<{ path: string; line: number; text: string }[]> {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const name of names) {
    if (!name || name === '(anonymous)') continue;
    try {
      const found = await git.searchText(new RegExp(`\\b${escapeRe(name)}\\b`), { maxHits: 20 });
      for (const h of found) {
        if (h.path !== selfPath) hits.push(h);
      }
    } catch {
      // 调用方检索失败即跳过
    }
  }
  return hits.slice(0, 20);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderSnippet(path: string, blocks: Block[], callers: { path: string; line: number; text: string }[]): string {
  const parts = [`### 上下文补全：${path}`];
  for (const b of blocks) {
    parts.push(`#### ${b.name}（第 ${b.startLine}-${b.endLine} 行，HEAD 版本）`);
    parts.push('```');
    parts.push(b.text);
    parts.push('```');
  }
  if (callers.length > 0) {
    parts.push('#### 直接调用方（工作区检索）');
    for (const c of callers) parts.push(`- ${c.path}:${c.line} \`${c.text.trim()}\``);
  }
  return parts.join('\n');
}
