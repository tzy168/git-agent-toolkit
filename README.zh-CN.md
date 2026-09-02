# git-agent-toolkit

[English](README.md) | **中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/tzy168/git-agent-toolkit/pulls)
[![GitHub stars](https://img.shields.io/github/stars/tzy168/git-agent-toolkit?style=social)](https://github.com/tzy168/git-agent-toolkit/stargazers)

> 基于 DeepSeek 的 Git 工作流 CLI。采集 git → 加工 diff → 组装 prompt → 调 DeepSeek → 渲染成 Markdown 报告落盘。

从暂存区生成提交信息，从分支对比产出审查、测试计划、影响面、PR 描述和技术方案。本地 CLI，报告落盘，数字来自 git 事实，不让模型加减文件数。

**如果这个工具帮到你，欢迎 [Star](https://github.com/tzy168/git-agent-toolkit) ；想一起把它做更好，欢迎 [提 Issue](https://github.com/tzy168/git-agent-toolkit/issues) 或 [开 PR](https://github.com/tzy168/git-agent-toolkit/pulls)。**

## 能做什么

| 命令 | 做什么 |
|---|---|
| `gat commit` | 暂存区 → 3 个提交信息候选 → 选一个提交 |
| `gat weekly` | 本周 log → 周报 |
| `gat review` | 代码审查（分片 + 汇总 + 跨文件） |
| `gat test-plan` | 测试计划（P0 / P1 / P2） |
| `gat impact` | 影响面分析（反向符号搜索） |
| `gat pr-desc` | PR 描述（按仓库模板填充） |
| `gat spec` | 技术方案反推 |
| `gat ask` | 自然语言挑命令 |

分支对比一律三点 diff：`git diff <base>...<head>`。除 `commit`（以及 hooks 写 `.git/hooks`）外，只读，不改被分析仓库的源码。

## 快速开始

需要 **Node ≥ 22** 和 [DeepSeek API Key](https://platform.deepseek.com/)。

```bash
git clone https://github.com/tzy168/git-agent-toolkit.git
cd git-agent-toolkit
npm install
npm run build
npm run link          # 全局注册 gat（git-agent 仍可用）
```

配置 API Key（二选一）：

```bash
# 全局（推荐）
mkdir -p ~/.git-agent
echo "DEEPSEEK_API_KEY=sk-xxx" > ~/.git-agent/.env

# 或仓库内
cp .env.example .env   # 填入真实 Key
```

然后在任意 git 仓库里：

```bash
gat commit
gat review --base origin/main
gat ask "帮我生成本周周报"
```

报告默认写到 `<repo>/.git-agent/reports/YYYY-MM/`，终端只打一行摘要。`--stdout` 打全文，`--json` 打结构化对象，`--dry-run` 打印 prompt、不调 API。

## 命令示例

```bash
gat commit                       # 暂存区 → 3 个提交信息候选 → 选一个提交
gat weekly --note "本周重点是重构"
gat review --base origin/main
gat test-plan --base origin/main
gat impact --base origin/main
gat pr-desc --base origin/main
gat spec --base origin/main
gat ask "帮我生成本周周报"
```

通用参数：`--base` `--head` `--out` `--stdout` `--json` `--dry-run` `--cache` `--no-cache` `-v` `--quiet`

缓存默认关闭，`--cache` 或配置 `cache.enabled: true` 才启用。

辅助命令：`gat config init`、`gat hooks install`、`gat cache stats`。

## 加一个新功能（3 步）

CLI 不用改。命令、参数、`--help` 全部从注册表自动生成。

1. 新建 `packages/core/src/features/<id>/index.ts`（实现 `Feature` 接口）+ `schema.ts`
2. 新建 `packages/core/prompts/<id>/*.md`
3. 在 `packages/core/src/features/index.ts` 加一行 `register(...)`

适合当第一次贡献：改 prompt、补单测、修文档，或加一个小 Feature。

## 架构

```
packages/cli     薄壳：argv、交互、退出码
packages/core    全部业务：git / diff / prompt / LLM / Feature
```

```
cli → Feature.collect → pipeline(buildSteps → LLM → zod → reduce) → render → 落盘
```

- `@git-agent/core` 禁止 import vscode / DOM / 任何 UI API
- Feature 只声明 steps，自己不调 LLM；`pipeline.ts` 是唯一编排者
- 接口签名与算法细节见 [`docs/architecture.md`](docs/architecture.md)

## 开发

```bash
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run dev -- commit  # tsx 直接跑 CLI
```

包管理器用 **npm**（workspaces）。TypeScript ESM + `module: NodeNext`，相对 import 必须带 `.js` 后缀。构建是 `tsc` 直出 `dist`，不做 bundle。

给编码代理的仓库手册：[`AGENTS.md`](AGENTS.md)。任务顺序：[`docs/tasks.md`](docs/tasks.md)。

## 参与贡献

这个项目欢迎任何人来改。不需要先成为 Git 或 LLM 专家。

**好上手的方向：**

- 给 `packages/core/test/` 补纯函数单测（parser、splitter、config loader、budget……）
- 改进 `packages/core/prompts/**/*.md`（改 prompt 等于改行为，请在 PR 里说明预期）
- 修 README / 架构文档里过时或含糊的句子
- 加一个小 Feature（按上面 3 步）
- 报 bug：附上命令、`--dry-run` 片段（注意打码 Key）、Node 版本

**提 PR 前：**

```bash
npm run typecheck
npm test
```

约定：

- 分支对比用三点语法 `git diff <base>...<head>`，禁止两点
- 只读：除 `commit` 外不写 git 状态、不改被分析仓库的源码
- `process.exit` 只允许出现在 CLI 的 `main()`；core 只抛 `GitAgentError`
- 日志只写 stderr；stdout 留给报告全文 / JSON / `--dry-run`
- 模型 id 只出现在 `config/defaults.ts` 的 `MODEL_FAST` / `MODEL_STRONG`

不确定改哪里？开一个 Issue 说说你想做的事，我们一起标 `good first issue`。

## Star

如果 `gat commit` 或 `gat review` 真的省了你一轮时间，点一下 Star。这是目前对这个仓库最直接的支持，也让后来的人更容易发现它。

[⭐ Star git-agent-toolkit](https://github.com/tzy168/git-agent-toolkit)

## 约定（使用侧）

- 报告默认落 `<repo>/.git-agent/reports/YYYY-MM/`，终端只打一行摘要
- 报告里的文件数 / 增删行 / commit 数来自 `data.stats`，不是模型算的
- 无 API Key 时 provider 能建成，第一次 LLM 调用才报 `NO_API_KEY`

## License

[MIT](LICENSE)
