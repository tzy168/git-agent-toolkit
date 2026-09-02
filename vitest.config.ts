import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// NodeNext 的 TS 源码相对 import 带 .js 后缀；测试直接跑 TS 源码，
// 这里把「相对路径 + .js」解析成同名 .ts 的绝对路径
function toFilePath(id: string): string {
  return id.startsWith('file://') ? fileURLToPath(id) : id;
}

export default defineConfig({
  plugins: [
    {
      name: 'map-relative-js-to-ts',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
        const abs = path.resolve(path.dirname(toFilePath(importer)), source);
        const ts = `${abs.slice(0, -3)}.ts`;
        try {
          if (fs.statSync(ts).isFile()) return ts;
        } catch {
          // 同名 .ts 不存在（真实 .js）→ 走默认解析
        }
        return null;
      },
    },
  ],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
