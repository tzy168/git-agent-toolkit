import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGitProvider } from '@git-agent/core';

import { EXIT } from '../exit.js';

const CONFIG_YML = `# git-agent 仓库级配置（.git-agent/config.yml）
# 留空的节用默认值；完整默认值见 ~/.git-agent 或文档
git:
  defaultBase: origin/main   # 分支对比基线
  includeAuthors: []          # 为空 = 全部作者
review:
  ignorePaths: []             # 追加到默认忽略表（node_modules/dist/lock 等已默认忽略）
  focusDimensions: []          # 审查维度，默认：正确性/边界/错误处理/性能/安全/可维护性/测试
  contextPaths: ['.git-agent/context']
commit:
  convention: conventional
  candidates: 3
  language: zh-CN
output:
  format: markdown
  language: zh-CN
cache:
  enabled: true
  maxAgeDays: 7
`;

const CONTEXT_EXAMPLE = `# 模块上下文示例

把本模块的业务约定写在这里，review / test-plan / pr-desc 会自动带上：

- 本目录是订单履约域，金额单位统一为"分"
- 所有对外接口必须走 gateway/errors.ts 的错误码表
`;

const RULES_MD = `# 团队规则（全局）

这里的规则会注入所有功能的 prompt。示例：

- 分支命名：feature/<ticket>-<slug>
- 提交规范：Conventional Commits，subject 用中文
- 禁止提交 .env 与任何密钥
`;

/** git-agent config init：生成仓库配置 + context 模板 + 全局 rules */
export async function configCommand(action: string, opts: { force?: boolean }): Promise<number> {
  if (action !== 'init') {
    console.error(`未知子命令：config ${action}（可用：init）`);
    return EXIT.ERR;
  }

  const git = await createGitProvider(process.cwd());
  const repo = await git.getRepoInfo();
  const agentDir = path.join(repo.root, '.git-agent');

  const targets: { file: string; content: string; label: string }[] = [
    { file: path.join(agentDir, 'config.yml'), content: CONFIG_YML, label: '仓库配置' },
    { file: path.join(agentDir, 'context', 'example.md'), content: CONTEXT_EXAMPLE, label: '模块上下文模板' },
    { file: path.join(os.homedir(), '.git-agent', 'rules.md'), content: RULES_MD, label: '全局团队规则' },
  ];

  for (const t of targets) {
    await mkdir(path.dirname(t.file), { recursive: true });
    try {
      await writeFile(t.file, t.content, { encoding: 'utf8', flag: opts.force ? 'w' : 'wx' });
      console.error(`✓ 已生成${t.label}：${t.file}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') console.error(`· 已存在，跳过：${t.file}`);
      else throw e;
    }
  }
  return EXIT.OK;
}
