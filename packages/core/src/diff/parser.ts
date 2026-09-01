import { extOf, toPosix } from '../paths.js';
import type { FileChange, FileStatus, Hunk } from '../types.js';
import { splitLines } from '../util/text.js';

const LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  css: 'css', scss: 'scss', md: 'md', json: 'json', yml: 'yml', yaml: 'yml',
  vue: 'vue', svelte: 'svelte', html: 'html', sh: 'sh',
};

const GENERATED = /(^|\/)(dist|build|coverage|__snapshots__)(\/|$)/;
const GENERATED_FILE = /\.(lock|min\.js|map)$/;

/** 路径是否像生成物（lock / dist / min.js / snapshots） */
export function isGeneratedPath(p: string): boolean {
  const posix = toPosix(p);
  return GENERATED.test(posix) || GENERATED_FILE.test(posix) || /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(posix);
}

function langOf(p: string): string | null {
  return LANG[extOf(p)] ?? (extOf(p) || null);
}

interface FileAcc {
  path: string;
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  hunks: Hunk[];
}

/** 把 unified diff 解析成 FileChange[]；按 \r?\n 切行 */
export function parseDiff(text: string): FileChange[] {
  if (text.trim() === '') return [];
  const lines = splitLines(text);
  const files: FileChange[] = [];
  let cur: FileAcc | null = null;

  const flush = (): void => {
    if (!cur) return;
    files.push(toFileChange(cur));
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      flush();
      const oldPath = toPosix(unquote(gitHeader[1] ?? ''));
      const newPath = toPosix(unquote(gitHeader[2] ?? ''));
      cur = { path: newPath, oldPath: oldPath !== newPath ? oldPath : undefined, status: 'M', isBinary: false, hunks: [] };
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) {
      cur.status = 'R';
      cur.oldPath = toPosix(line.slice('rename from '.length).trim());
    } else if (line.startsWith('copy from ')) {
      cur.status = 'C';
      cur.oldPath = toPosix(line.slice('copy from '.length).trim());
    } else if (line.startsWith('rename to ')) cur.path = toPosix(line.slice('rename to '.length).trim());
    else if (/^Binary files /.test(line) || line.startsWith('GIT binary patch')) cur.isBinary = true;
    else if (line.startsWith('@@ ')) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        cur.hunks.push(hunk);
        i = readHunkLines(lines, i + 1, hunk) - 1;
      }
    }
  }
  flush();
  return files;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

function parseHunkHeader(line: string): Hunk | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return null;
  const context = (m[5] ?? '').trim();
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    context: context || undefined,
    lines: [],
  };
}

function readHunkLines(lines: string[], start: number, hunk: Hunk): number {
  let i = start;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
    const ch = line.charAt(0);
    if (ch === '\\') continue;
    if (ch === '+') {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (ch === '-') {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (ch === ' ' || ch === '') {
      hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else {
      break;
    }
  }
  return i;
}

function toFileChange(cur: FileAcc): FileChange {
  let additions = 0;
  let deletions = 0;
  for (const h of cur.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }
  return {
    path: cur.path,
    oldPath: cur.oldPath,
    status: cur.status,
    additions,
    deletions,
    isBinary: cur.isBinary,
    isGenerated: isGeneratedPath(cur.path) || (cur.oldPath ? isGeneratedPath(cur.oldPath) : false),
    language: langOf(cur.path),
    hunks: cur.hunks,
  };
}

/** 把 FileChange 还原成 unified diff 文本（过滤后再拼 diffText / chunk 用） */
export function fileToUnifiedDiff(file: FileChange): string {
  const oldPath = file.oldPath ?? file.path;
  const lines: string[] = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.status === 'A') lines.push('new file mode 100644');
  if (file.status === 'D') lines.push('deleted file mode 100644');
  if (file.status === 'R' && file.oldPath) {
    lines.push(`rename from ${file.oldPath}`, `rename to ${file.path}`);
  }
  if (file.isBinary) {
    lines.push(`Binary files a/${oldPath} and b/${file.path} differ`);
    return lines.join('\n');
  }
  lines.push(file.status === 'A' ? '--- /dev/null' : `--- a/${oldPath}`);
  lines.push(file.status === 'D' ? '+++ /dev/null' : `+++ b/${file.path}`);
  for (const h of file.hunks) {
    const ctx = h.context ? ` ${h.context}` : '';
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${ctx}`);
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      lines.push(prefix + l.text);
    }
  }
  return lines.join('\n');
}

/** 统计过滤后的 files */
export function statsOf(files: FileChange[]): { files: number; additions: number; deletions: number; byExt: Record<string, { files: number; additions: number; deletions: number }> } {
  const byExt: Record<string, { files: number; additions: number; deletions: number }> = {};
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
    const ext = extOf(f.path) || '(none)';
    const slot = (byExt[ext] ??= { files: 0, additions: 0, deletions: 0 });
    slot.files++;
    slot.additions += f.additions;
    slot.deletions += f.deletions;
  }
  return { files: files.length, additions, deletions, byExt };
}
