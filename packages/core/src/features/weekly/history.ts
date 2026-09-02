import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** 扫 .git-agent/reports/YYYY-MM/weekly-*.md，取最近一期内容；没有返回 null */
export async function findLastWeeklyReport(repoRoot: string): Promise<string | null> {
  const reportsDir = path.join(repoRoot, '.git-agent', 'reports');
  let months: string[];
  try {
    months = (await readdir(reportsDir)).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort().reverse();
  } catch {
    return null;
  }
  for (const month of months) {
    const dir = path.join(reportsDir, month);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => /^weekly-.*\.md$/.test(n)).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        return await readFile(path.join(dir, name), 'utf8');
      } catch {
        // 读失败试下一份
      }
    }
  }
  return null;
}
