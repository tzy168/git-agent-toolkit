import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 单行选择：返回用户输入的 trim 后文本；非 TTY 返回 null */
export async function selectOne(msg: string, items: string[]): Promise<string | null> {
  if (!output.isTTY || !input.isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    console.error(msg);
    for (const item of items) console.error(`  ${item}`);
    const answer = (await rl.question('> ')).trim();
    return answer;
  } finally {
    rl.close();
  }
}

/** 单行输入，提示写 stderr；非 TTY 返回 null */
export async function promptLine(msg: string): Promise<string | null> {
  if (!process.stderr.isTTY || !input.isTTY) return null;
  const rl = createInterface({ input, output: process.stderr });
  try {
    return (await rl.question(msg)).trim();
  } finally {
    rl.close();
  }
}

/** y/n 确认；非 TTY 视为否 */
export async function confirm(msg: string): Promise<boolean> {
  if (!output.isTTY || !input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${msg} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** 用 $EDITOR / notepad 打开临时文件编辑，返回保存后的文本 */
export async function editInEditor(initial: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'git-agent-'));
  const file = path.join(dir, 'COMMIT_EDITMSG');
  await writeFile(file, initial, 'utf8');
  const editor = process.env.GIT_EDITOR || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit', shell: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`编辑器退出码 ${code}`))));
    child.on('error', reject);
  });
  return (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n').trim();
}
