import { execSync } from 'node:child_process';

/** 当前 stderr 是否是交互终端 */
export function isTty(): boolean {
  return Boolean(process.stderr.isTTY);
}

/** Windows 下代码页不是 UTF-8 时提示一次，避免中文乱码 */
export function checkTerminal(): void {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync('chcp', { encoding: 'utf8' });
    if (!/65001/.test(out)) {
      console.error('提示：当前终端不是 UTF-8（chcp 65001）。若中文乱码，先执行 chcp 65001');
    }
  } catch {
    // 忽略探测失败
  }
}
