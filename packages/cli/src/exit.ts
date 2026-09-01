import type { ExitCode } from '@git-agent/core';

export const EXIT = { OK: 0, ERR: 1, BLOCKER: 2, NO_DATA: 3 } as const;

/** 带可选信息的退出；只应被 main() 调用 */
export function exitWith(code: ExitCode, msg?: string): never {
  if (msg) console.error(msg);
  process.exit(code);
}
