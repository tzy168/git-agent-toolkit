import path from 'node:path';

/** ts-morph 反向索引：name → 引用命中；file → 重新导出/封装检测。ts-morph 缺席返回 null。 */

export interface RefHit {
  path: string; // posix 相对路径
  line: number;
  text: string;
}

export interface MorphIndex {
  /** 引擎标识，写进 ReverseSearchResult.mode */
  readonly engine: 'ts-morph';
  refsOf(name: string, cap: number): RefHit[];
  /** 文件内把 sym 重新导出 / 封装的新符号名 */
  wrappersOf(file: string, sym: string): string[];
}

/** 扫描文件数上限（与 reverse-search 的 FILE_CAP 对齐） */
const FILE_CAP = 4000;

export async function buildMorphIndex(root: string, files: string[]): Promise<MorphIndex | null> {
  let morph: typeof import('ts-morph');
  try {
    morph = (await import('ts-morph')) as typeof import('ts-morph');
  } catch {
    return null; // optionalDependencies 未装 → 调用方降级 grep
  }

  const project = new morph.Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  const tsFiles = files.filter((f) => /\.tsx?$/.test(f)).slice(0, FILE_CAP);
  const absToRel = new Map<string, string>();
  for (const f of tsFiles) {
    const abs = path.resolve(root, f);
    absToRel.set(abs, f);
    try {
      project.addSourceFileAtPath(abs);
    } catch {
      // 单文件解析失败跳过
    }
  }

  // name → 引用命中（AST 保证命中位置是真标识符，排除字符串/注释）
  const refs = new Map<string, RefHit[]>();
  const sources = project.getSourceFiles();
  for (const sf of sources) {
    const rel = absToRel.get(sf.getFilePath());
    if (!rel) continue;
    const lines = sf.getFullText().split(/\r?\n/);
    for (const id of sf.getDescendantsOfKind(morph.SyntaxKind.Identifier)) {
      const name = id.getText();
      const line = id.getStartLineNumber();
      let list = refs.get(name);
      if (!list) refs.set(name, (list = []));
      list.push({ path: rel, line, text: (lines[line - 1] ?? '').trim() });
    }
  }

  return {
    engine: 'ts-morph',
    refsOf(name, cap) {
      return (refs.get(name) ?? []).slice(0, cap);
    },
    wrappersOf(file, sym) {
      const abs = path.resolve(root, file);
      const sf = project.getSourceFile(abs);
      if (!sf) return [];
      const out = new Set<string>();
      // re-export：export { sym as alias } / export { alias as sym }
      for (const decl of sf.getExportDeclarations()) {
        for (const spec of decl.getNamedExports()) {
          const alias = spec.getAliasNode()?.getText();
          const orig = spec.getNameNode().getText();
          if (orig === sym && alias) out.add(alias);
          else if (alias === sym) out.add(orig);
        }
      }
      // 封装：export function wrapper() { ...sym... }
      for (const fn of sf.getFunctions()) {
        if (!fn.hasExportKeyword()) continue;
        const name = fn.getName();
        if (!name || name === sym) continue;
        const uses = fn.getBody()?.getDescendantsOfKind(morph.SyntaxKind.Identifier) ?? [];
        if (uses.some((id) => id.getText() === sym)) out.add(name);
      }
      return [...out];
    },
  };
}
