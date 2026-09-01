import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

import type { Logger } from '../types.js';

export interface DiskCache {
  /** 读缓存；未命中、过期、损坏一律返回 null，绝不抛错 */
  read<T>(ns: string, key: string): Promise<T | null>;
  /** 写缓存；失败只记 warn，绝不中断主流程 */
  write<T>(ns: string, key: string, value: T): Promise<void>;
  /** 清理某个命名空间（不给则全清），返回清理条数 */
  clear(ns?: string): Promise<number>;
  stats(): Promise<{ entries: number; sizeBytes: number }>;
  /** 缓存根目录（绝对路径） */
  readonly root: string;
  readonly enabled: boolean;
}

export interface DiskCacheOptions {
  enabled?: boolean;
  maxAgeDays?: number;
  /** 相对仓库根的目录，默认 '.git-agent/cache' */
  dir?: string;
  logger?: Logger;
}

interface Envelope<T> {
  savedAt: number;
  value: T;
}

const DAY_MS = 86_400_000;

/** key 里可能含 ':' 等 Windows 非法字符，统一清洗成文件名安全串 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 创建磁盘 KV 缓存，落在 `<root>/<dir>/<ns>/<key>.json` */
export function createDiskCache(root: string, opts: DiskCacheOptions = {}): DiskCache {
  const enabled = opts.enabled !== false;
  const maxAgeDays = opts.maxAgeDays ?? 7;
  const logger = opts.logger;
  const base = path.resolve(root, opts.dir ?? '.git-agent/cache');

  const fileFor = (ns: string, key: string): string => path.join(base, ns, `${safeKey(key)}.json`);

  const cache: DiskCache = {
    root: base,
    enabled,

    async read<T>(ns: string, key: string): Promise<T | null> {
      if (!enabled) return null;
      const file = fileFor(ns, key);
      try {
        const raw = await readFile(file, 'utf8');
        const envelope = JSON.parse(raw) as Envelope<T>;
        if (typeof envelope?.savedAt !== 'number') return null;
        if (maxAgeDays > 0 && Date.now() - envelope.savedAt > maxAgeDays * DAY_MS) return null;
        return envelope.value;
      } catch {
        // 文件不存在 / JSON 损坏 / 权限问题 —— 一律视为未命中
        return null;
      }
    },

    async write<T>(ns: string, key: string, value: T): Promise<void> {
      if (!enabled) return;
      const file = fileFor(ns, key);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const envelope: Envelope<T> = { savedAt: Date.now(), value };
        await writeFile(file, JSON.stringify(envelope), 'utf8');
      } catch (e) {
        logger?.warn(`写缓存失败（已忽略）：${file} — ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async clear(ns?): Promise<number> {
      const targets = ns ? [path.join(base, ns)] : [base];
      let removed = 0;
      for (const dir of targets) {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            removed += await cache.clear(ns ? `${ns}/${entry.name}` : entry.name);
            continue;
          }
          if (!entry.name.endsWith('.json')) continue;
          try {
            await rm(full, { force: true });
            removed++;
          } catch (e) {
            logger?.warn(`删除缓存失败（已忽略）：${full} — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return removed;
    },

    async stats(): Promise<{ entries: number; sizeBytes: number }> {
      let entries = 0;
      let sizeBytes = 0;
      const walk = async (dir: string): Promise<void> => {
        let list: string[];
        try {
          list = await readdir(dir, { withFileTypes: true }).then((d) => d.map((x) => x.name));
        } catch {
          return;
        }
        for (const name of list) {
          const full = path.join(dir, name);
          const info = await stat(full).catch(() => null);
          if (!info) continue;
          if (info.isDirectory()) {
            await walk(full);
          } else if (name.endsWith('.json')) {
            entries++;
            sizeBytes += info.size;
          }
        }
      };
      await walk(base);
      return { entries, sizeBytes };
    },
  };

  return cache;
}
