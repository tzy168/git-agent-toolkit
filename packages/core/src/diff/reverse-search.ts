import type { GitProvider } from '../git/types.js';
import type { FileChange } from '../types.js';
import { buildMorphIndex, type MorphIndex, type RefHit } from './reverse-search-morph.js';

export type SymbolKind = 'function' | 'class' | 'type' | 'const' | 'component' | 'unknown';

export interface SymbolChange {
  path: string;
  name: string;
  kind: SymbolKind;
  change: 'added' | 'modified' | 'removed';
  signature?: string;
  hunkLine?: number;
}

export interface ReferenceHit {
  path: string;
  line: number;
  text: string;
  symbol: string;
  /** 1 = 直接，2 = 间接 */
  depth: number;
  /** depth=2 时的中间符号名 */
  via?: string;
}

export interface ReverseSearchResult {
  symbols: SymbolChange[];
  direct: ReferenceHit[];
  indirect: ReferenceHit[];
  mode: 'ts-morph' | 'grep';
  truncated: boolean;
}

export interface ReverseSearchOpts {
  maxDepth: number;
  includeTests: boolean;
  mode: 'ts-morph' | 'grep';
}

/** 上溯层数硬上限：禁止更深（防指数爆炸） */
export const REVERSE_MAX_DEPTH = 2;
/** 扫描文件数上限 */
const FILE_CAP = 4000;
/** 单符号命中上限 */
const HIT_CAP = 200;

const DECL_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

const KIND_MAP: Record<string, SymbolKind> = {
  function: 'function',
  'function*': 'function',
  class: 'class',
  const: 'const',
  let: 'const',
  var: 'const',
  interface: 'type',
  type: 'type',
  enum: 'type',
};

/** 从 +/- 行提取被改的导出符号；同文件同名的 +/- 并存记为 modified */
export function extractChangedSymbols(files: FileChange[]): SymbolChange[] {
  const out = new Map<string, SymbolChange>();
  for (const file of files) {
    if (file.isBinary) continue;
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.type === 'ctx') continue;
        const m = l.text.match(DECL_RE);
        if (!m || !m[2]) continue;
        const kind = refineKind(KIND_MAP[m[1] ?? ''] ?? 'unknown', m[2], file.path);
        const key = `${file.path}:${m[2]}`;
        const line = l.type === 'add' ? l.newNo : l.oldNo;
        if (l.type === 'add') {
          added.add(m[2]);
          out.set(key, { path: file.path, name: m[2], kind, change: 'added', signature: l.text.trim(), hunkLine: line ?? undefined });
        } else {
          removed.add(m[2]);
          if (!out.has(key)) {
            out.set(key, { path: file.path, name: m[2], kind, change: 'removed', signature: l.text.trim(), hunkLine: line ?? undefined });
          }
        }
      }
    }
    for (const name of added) {
      if (!removed.has(name)) continue;
      const sc = out.get(`${file.path}:${name}`);
      if (sc) sc.change = 'modified';
    }
  }
  return [...out.values()];
}

/** tsx 文件中大写开头的函数按组件归类 */
function refineKind(kind: SymbolKind, name: string, path: string): SymbolKind {
  if (kind === 'function' && /\.tsx$/.test(path) && /^[A-Z]/.test(name)) return 'component';
  return kind;
}

/**
 * 反向引用搜索：symbols → direct（depth 1）→ indirect（depth ≤ 2）。
 * depth=2 依赖命中文件里的「重新导出 / 封装」新符号，对每个新符号再扫一轮。
 */
export async function reverseSearch(
  git: GitProvider,
  symbols: SymbolChange[],
  opts: ReverseSearchOpts,
): Promise<ReverseSearchResult> {
  const maxDepth = Math.min(opts.maxDepth, REVERSE_MAX_DEPTH);
  let truncated = false;

  // ts-morph 模式：装了才用，构建失败（缺包/解析异常）降级 grep
  let morph: MorphIndex | null = null;
  if (opts.mode === 'ts-morph') {
    try {
      const repo = await git.getRepoInfo();
      morph = await buildMorphIndex(repo.root, (await git.listRepoFiles()).slice(0, FILE_CAP));
    } catch {
      morph = null;
    }
  }
  const mode: 'ts-morph' | 'grep' = morph ? 'ts-morph' : 'grep';

  const direct: ReferenceHit[] = [];
  const indirect: ReferenceHit[] = [];
  const seen = new Set<string>();

  // depth 1
  const wrappers: { file: string; name: string; via: string }[] = [];
  for (const sym of symbols) {
    if (!sym.name) continue;
    const hits = morph
      ? filterHits(morph.refsOf(sym.name, HIT_CAP + 1), sym.path, opts.includeTests)
      : await scanViaGrep(git, sym.name, sym.path, opts.includeTests);
    if (hits.length > HIT_CAP) truncated = true;
    for (const h of hits.slice(0, HIT_CAP)) {
      seen.add(`${h.path}:${h.line}:${sym.name}`);
      direct.push({ ...h, symbol: sym.name, depth: 1 });
    }
    if (maxDepth >= 2) {
      for (const file of [...new Set(hits.map((h) => h.path))].slice(0, HIT_CAP)) {
        const names = morph
          ? morph.wrappersOf(file, sym.name)
          : await wrappersViaText(git, file, sym.name);
        for (const n of names) wrappers.push({ file, name: n, via: sym.name });
      }
    }
  }

  // depth 2
  if (maxDepth >= 2) {
    for (const w of wrappers) {
      if (w.name === w.via) continue;
      const hits = morph
        ? filterHits(morph.refsOf(w.name, HIT_CAP + 1), w.file, opts.includeTests)
        : await scanViaGrep(git, w.name, w.file, opts.includeTests);
      if (hits.length > HIT_CAP) truncated = true;
      for (const h of hits.slice(0, HIT_CAP)) {
        const key = `${h.path}:${h.line}:${w.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        indirect.push({ ...h, symbol: w.name, depth: 2, via: w.via });
      }
    }
  }

  return { symbols, direct, indirect, mode, truncated };
}

function filterHits(hits: RefHit[], selfPath: string, includeTests: boolean): RefHit[] {
  return hits.filter((h) => h.path !== selfPath && (includeTests || !isTestPath(h.path)));
}

/** grep 模式：git.searchText 逐文件正则扫描 */
async function scanViaGrep(git: GitProvider, name: string, selfPath: string, includeTests: boolean): Promise<RefHit[]> {
  try {
    const hits = await git.searchText(new RegExp(`\\b${escapeRe(name)}\\b`), { maxHits: HIT_CAP + 1 });
    return filterHits(hits, selfPath, includeTests);
  } catch {
    return []; // 检索失败即降级为空结果，不中断
  }
}

/** grep 模式的封装/re-export 检测：读 HEAD 文本做正则近似 */
async function wrappersViaText(git: GitProvider, file: string, sym: string): Promise<string[]> {
  const text = await git.getFileAt('HEAD', file);
  if (!text) return [];
  const out = new Set<string>();
  const nameRe = escapeRe(sym);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const seg = part.trim();
      if (seg === '') continue;
      const as1 = seg.match(new RegExp(`(?:${nameRe})\\s+as\\s+([A-Za-z_$][\\w$]*)`));
      if (as1?.[1]) out.add(as1[1]);
      const as2 = seg.match(new RegExp(`([A-Za-z_$][\\w$]*)\\s+as\\s+(?:${nameRe})`));
      if (as2?.[1]) out.add(as2[1]);
    }
  }
  // export function wrapper() { ...sym... }，行级大括号配平
  const lines = text.split(/\r?\n/);
  const useRe = new RegExp(`\\b${nameRe}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] as string).match(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/);
    if (!m?.[1] || m[1] === sym) continue;
    if (useRe.test(lines.slice(i, braceEnd(lines, i) + 1).join('\n'))) out.add(m[1]);
  }
  return [...out];
}

function isTestPath(p: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(p) || /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(p);
}

/** 从 from 行起大括号配平，返回闭合行号 */
function braceEnd(lines: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    for (const ch of lines[i] as string) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
  }
  return lines.length - 1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
