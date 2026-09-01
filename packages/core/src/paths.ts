import path from 'node:path';

/** 统一转成 posix 分隔符（Windows 的 `\` → `/`） */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 绝对路径 + posix 分隔符 */
export function absPosix(p: string): string {
  return toPosix(path.resolve(p));
}

/** 计算相对路径并返回 posix 形式 */
export function relativeTo(root: string, p: string): string {
  return toPosix(path.relative(root, p));
}

/** Windows 下大小写不敏感、分隔符不敏感的路径比较 */
export function samePath(a: string, b: string): boolean {
  const norm = (v: string) => toPosix(path.resolve(v)).replace(/\/+$/, '');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** 分支名 → 文件名安全片段（'feature/xxx' → 'feature-xxx'，剔非法字符） */
export function safeBranchName(branch: string): string {
  const cleaned = branch
    .trim()
    .replace(/[<>:"|?*]/g, '')
    .replace(/[/\\]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || 'HEAD';
}

/** 取文件路径的扩展名（小写，不含点）；无扩展名返回 '' */
export function extOf(p: string): string {
  const base = toPosix(p).split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** 取路径的前 n 层目录；不足则返回实际层级，根目录文件返回 '.' */
export function topDirs(p: string, n = 2): string {
  const posix = toPosix(p);
  const parts = posix.split('/').filter(Boolean);
  if (parts.length <= 1) return '.';
  return parts.slice(0, Math.min(n, parts.length - 1)).join('/');
}
