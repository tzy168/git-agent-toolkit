import { createGitProvider } from 'git-agent-core';

import { EXIT } from '../exit.js';

const HOOK_NAME = 'prepare-commit-msg';

const HOOK_SCRIPT = `#!/bin/sh
# installed by: git-agent hooks install
# 禁用方式：GIT_AGENT_DISABLE=1 git commit ...
if [ -n "$GIT_AGENT_DISABLE" ]; then
  exit 0
fi
# git commit --no-verify 不跳过 prepare-commit-msg；需要干净提交时用 GIT_AGENT_DISABLE
git-agent commit --prefill --out "$1" >/dev/null 2>&1 || true
exit 0
`;

/** git-agent hooks install|uninstall：管理 .git/hooks/prepare-commit-msg */
export async function hooksCommand(action: string): Promise<number> {
  const git = await createGitProvider(process.cwd());

  if (action === 'install') {
    await git.installHook(HOOK_NAME, HOOK_SCRIPT);
    console.error(`✓ 已安装 ${HOOK_NAME}（.git/hooks/${HOOK_NAME}）`);
    console.error('  之后 git commit（不带 -m）会预填 AI 生成的提交信息');
    console.error('  临时禁用：GIT_AGENT_DISABLE=1 git commit ...');
    return EXIT.OK;
  }
  if (action === 'uninstall') {
    await git.uninstallHook(HOOK_NAME);
    console.error(`✓ 已卸载 ${HOOK_NAME}`);
    return EXIT.OK;
  }
  console.error(`未知子命令：hooks ${action}（可用：install / uninstall）`);
  return EXIT.ERR;
}
