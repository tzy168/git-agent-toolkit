import { Command } from 'commander';

import { GitAgentError, isGitAgentError, registerAll } from '@git-agent/core';

import { EXIT, exitWith } from './exit.js';
import { registerCommands } from './register-commands.js';
import { checkTerminal } from './terminal.js';

/** CLI 入口：全项目唯一允许 process.exit 的地方 */
export async function main(): Promise<void> {
  checkTerminal();
  registerAll();

  const program = new Command();
  program
    .name('git-agent')
    .description('基于 DeepSeek 的个人 Git 工作流工具箱')
    .version('0.1.0')
    .showHelpAfterError()
    .exitOverride((err) => {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exit(0);
      if (err.code === 'commander.help') process.exit(0);
      throw err;
    });

  registerCommands(program);

  try {
    await program.parseAsync(process.argv);
    if (!process.argv.slice(2).length) program.help();
  } catch (e) {
    if (isGitAgentError(e) || e instanceof GitAgentError) {
      const err = e as GitAgentError;
      const code = err.code === 'NO_DATA' ? EXIT.NO_DATA : EXIT.ERR;
      exitWith(code, err.toDisplayString());
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("error: unknown command") || msg.includes('too many arguments')) {
      console.error(msg);
      process.exit(EXIT.ERR);
    }
    exitWith(EXIT.ERR, msg);
  }
}
