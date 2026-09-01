import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

import { GitAgentError } from '../errors.js';
import { toPosix } from '../paths.js';
import type { RepoInfo } from '../types.js';
import type { CommitInfo, GitProvider, GrepHit, LogOptions } from './types.js';

const GIT_OPTS = { maxConcurrentProcesses: 6, trimmed: false } as const;
const SEARCH_FILE_CAP = 4000;
const SEARCH_HIT_CAP = 200;

function wrap(e: unknown, code: 'GIT_FAILED' | 'NOT_A_REPO' | 'REF_NOT_FOUND', message: string, hint?: string): GitAgentError {
  if (e instanceof GitAgentError) return e;
  return new GitAgentError(code, message, hint, e);
}

async function raw(git: SimpleGit, args: string[]): Promise<string> {
  try {
    return await git.raw(args);
  } catch (e) {
    throw wrap(e, 'GIT_FAILED', `git ${args.join(' ')} 失败`, '确认当前目录是 git 仓库且 ref 存在');
  }
}

/** 基于 simple-git 的 GitProvider；三点 diff 语法在 getBranchDiff 内写死 */
export async function createGitProvider(cwd: string): Promise<GitProvider> {
  const git = simpleGit({ baseDir: cwd, ...GIT_OPTS });
  try {
    await git.revparse(['--is-inside-work-tree']);
  } catch (e) {
    throw wrap(e, 'NOT_A_REPO', `${cwd} 不是 git 仓库`, '在仓库根目录运行 git-agent');
  }

  const root = toPosix((await git.revparse(['--show-toplevel'])).trim());
  const local = simpleGit({ baseDir: root, ...GIT_OPTS });

  const provider: GitProvider = {
    async getRepoInfo(): Promise<RepoInfo> {
      const branch = (await local.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const headSha = (await local.revparse(['HEAD'])).trim();
      const status = await local.status();
      const name = (await local.getConfig('user.name')).value;
      const email = (await local.getConfig('user.email')).value;
      return {
        root,
        branch: branch || 'HEAD',
        headSha,
        isDirty: !status.isClean(),
        author: name || email ? { name: name ?? '', email: email ?? '' } : null,
      };
    },

    async resolveRef(ref) {
      try {
        return (await local.revparse(['--verify', `${ref}^{commit}`])).trim();
      } catch (e) {
        throw wrap(e, 'REF_NOT_FOUND', `找不到 ref：${ref}`, '检查 --base / --head 是否存在（先 git fetch）');
      }
    },

    async getMergeBase(base, head = 'HEAD') {
      const out = (await raw(local, ['merge-base', base, head])).trim();
      if (!out) throw new GitAgentError('GIT_FAILED', `无法计算 merge-base：${base} ${head}`);
      return out;
    },

    async getBranchDiff(base, head = 'HEAD') {
      // 三点语法铁律：只含本分支相对 merge-base 的改动
      const spec = `${base}...${head}`;
      const text = await raw(local, ['diff', '--binary', spec]);
      const numstat = await raw(local, ['diff', '--numstat', spec]);
      return { text, numstat };
    },

    async getStagedDiff() {
      const text = await raw(local, ['diff', '--binary', '--cached']);
      const numstat = await raw(local, ['diff', '--numstat', '--cached']);
      return { text, numstat, isEmpty: text.trim() === '' };
    },

    async getLog(opts: LogOptions = {}) {
      const args = ['log', '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b%x1e'];
      if (opts.all) args.push('--all');
      if (opts.maxCount) args.push(`-${opts.maxCount}`);
      if (opts.since) args.push(`--since=${opts.since}`);
      if (opts.until) args.push(`--until=${opts.until}`);
      for (const a of opts.authors ?? []) args.push(`--author=${a}`);
      if (opts.withNumstat) args.push('--numstat');
      if (opts.range) args.push(opts.range);
      const out = await raw(local, args);
      return parseLog(out);
    },

    async getRecentSubjects(n) {
      if (n <= 0) return [];
      const out = await raw(local, ['log', `-${n}`, '--pretty=format:%s']);
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    },

    async getFileAt(ref, filePath) {
      try {
        return await local.show([`${ref}:${toPosix(filePath)}`]);
      } catch {
        return null;
      }
    },

    async listRepoFiles() {
      const out = await raw(local, ['ls-files', '-z']);
      return out.split('\0').map(toPosix).filter(Boolean);
    },

    async searchText(pattern, opts = {}) {
      const files = opts.paths?.length ? opts.paths : await provider.listRepoFiles();
      const maxHits = opts.maxHits ?? SEARCH_HIT_CAP;
      const hits: GrepHit[] = [];
      const capped = files.slice(0, SEARCH_FILE_CAP);
      for (const file of capped) {
        let text: string;
        try {
          const buf = await readFile(path.resolve(root, file));
          if (buf.includes(0)) continue;
          text = buf.toString('utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          pattern.lastIndex = 0;
          if (!pattern.test(line)) continue;
          hits.push({ path: file, line: i + 1, text: line });
          if (hits.length >= maxHits) return hits;
        }
      }
      return hits;
    },

    async commit(message) {
      try {
        await local.commit(message);
      } catch (e) {
        throw wrap(e, 'GIT_FAILED', 'git commit 失败', '检查暂存区是否仍有改动、hooks 是否阻断');
      }
    },

    async installHook(name, script) {
      const file = path.join(root, '.git', 'hooks', name);
      try {
        await writeFile(file, script, { encoding: 'utf8', mode: 0o755 });
      } catch (e) {
        throw wrap(e, 'GIT_FAILED', `写入 hook 失败：${file}`);
      }
    },

    async uninstallHook(name) {
      const file = path.join(root, '.git', 'hooks', name);
      try {
        await unlink(file);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw wrap(e, 'GIT_FAILED', `删除 hook 失败：${file}`);
      }
    },
  };

  return provider;
}

function parseLog(rawOut: string): CommitInfo[] {
  if (rawOut.trim() === '') return [];
  const records = rawOut.split('\x1e');
  const out: CommitInfo[] = [];
  for (const rec of records) {
    const chunk = rec.replace(/^\r?\n/, '');
    if (!chunk.trim()) continue;
    const [meta, ...rest] = chunk.split(/\r?\n/);
    const parts = (meta ?? '').split('\0');
    if (parts.length < 6) continue;
    const [sha, shortSha, author, email, date, subject, bodyHead] = parts;
    const bodyTail = rest.join('\n').trim();
    const body = [bodyHead, bodyTail].filter(Boolean).join('\n').trim();
    out.push({
      sha: sha ?? '',
      shortSha: shortSha ?? '',
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      subject: subject ?? '',
      body,
    });
  }
  return out;
}
