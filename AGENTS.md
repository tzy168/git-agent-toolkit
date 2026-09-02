# AGENTS.md

给编码代理用的仓库手册。接口签名、算法阈值、文件职责以 [`docs/architecture.md`](docs/architecture.md) 为准；任务顺序以 [`docs/tasks.md`](docs/tasks.md) 为准。不要凭 README 里的「七个命令」假设功能已经写完。

## 这是什么

个人 Git 工作流工具箱：采集 git → 加工 diff → 组装 prompt → 调 DeepSeek → 落 Markdown。npm workspaces，两包：

| 包 | 职责 |
|---|---|
| `@git-agent/core` | 全部业务。禁止 import vscode / DOM / 任何 UI API |
| `git-agent-toolkit`（CLI） | 薄壳：解析 argv、组 `FeatureContext`、交互、退出码。命令从 registry 自动生成 |

运行时 Node ≥ 22，TypeScript **ESM + `module: NodeNext`**。相对 import **必须带 `.js` 后缀**（`import { x } from './foo.js'`）。构建是 `tsc` 直出 `dist`，不做 bundle。包管理器用 **npm**，不要引入 pnpm/yarn。

## 当前进度（对照 tasks.md）

已落地：T01 基础设施、T02 的 git/diff（parser · filter · splitter）、T03 的 registry / pipeline / CLI 骨架 / **`commit`**。

尚未落地（按任务做，不要提前大改 core）：

- T02 尾巴：`collect-branch.ts`、`collect-log.ts`
- T03 尾巴：`weekly`、CLI 的 `config` / `hooks` / `cache` 子命令、`src/render/`
- T04：`review`、`test-plan`、`diff/enricher.ts`
- T05：`impact`、`pr-desc`、`spec`、`diff/reverse-search.ts`、`ask`
- 单测：`packages/core/test/**.test.ts` 目前是空的，补功能时顺手写必测纯函数

## 常用命令

```bash
npm install
npm run build          # 两包 tsc + 拷贝 prompts/*.md → core/dist/prompts
npm run typecheck
npm test               # vitest run（尚无用例也要能跑）
npm run dev -- commit  # tsx 直接跑 CLI，后面跟子命令和参数
```

全局命令：`gat`（`git-agent` 仍可用）。API Key 在 `~/.git-agent/.env` 或仓库 `.env`。TTY 下缺 Key 时 CLI 提示输入并写入 `~/.git-agent/.env`；非 TTY / `--prefill` / `--dry-run` 不提示，provider 仍能建成，第一次 LLM 调用才抛 `NO_API_KEY`。

## 加新功能（只这 3 步）

1. `packages/core/src/features/<id>/index.ts` 实现 `Feature` + `schema.ts`
2. `packages/core/prompts/<id>/*.md`
3. `packages/core/src/features/index.ts` 加一行 `register(...)`

不要改 CLI 去挂命令。`params` 会进 `--help`。`pipeline.ts` 是唯一编排者：Feature 只声明 steps，自己不调 LLM。

采集优先复用 `features/shared/`（`collect-branch` / `collect-staged` / `collect-log`），五个分支对比命令必须共用同一份 `branch-diff` 缓存指纹。

## 铁律（违反即 bug）

1. **三点 diff**：`git diff <base>...<head>`。禁止两点。`git log <base>..<head>` 才是两点。
2. **只读**：除 `commit` 命令（及 hooks 写 `.git/hooks`）外，不改 git 状态、不改被分析仓库的源码。
3. **git 进程只允许出现在** `packages/core/src/git/cli-provider.ts`。
4. **`process.exit` 只允许** `packages/cli/src/index.ts` 的 `main()`（经 `exit.ts`）。core 只抛 `GitAgentError`。
5. **日志只写 stderr**。core 里禁止 `console.log`。stdout 留给报告全文 / JSON / `--dry-run` prompt。
6. **模型 id** 只出现在 `config/defaults.ts` 的 `MODEL_FAST` / `MODEL_STRONG`（`deepseek-v4-flash` / `deepseek-v4-pro`）。禁止 `deepseek-chat` / `deepseek-reasoner`。
7. **报告数字来自 `data.stats`**，禁止让模型加减文件数 / 增删行 / commit 数。
8. **路径内部一律 posix `/`**。比较用 `samePath()`。写文件 UTF-8 + LF。解析 git 输出按 `\r?\n` 切行。
9. **缓存读失败当未命中，写失败 warn 后继续**。enrich / 模块 context 同样失败即降级。
10. **`commit --prefill`**：任何错误吞掉，debug 一行，退出 0。
11. **Prompt 布局**：`composePrompt` 的 variable（diff/log/note）永远在 user 末尾。分片 map 的 `system` 必须字节完全一致（算一次、复用同一字符串）。
12. **全局注入** `prompts/shared/anti-hallucination.md`。

## 分层与退出码

```
cli → Feature.collect → pipeline(buildSteps → LLM → zod → reduce) → render → 落盘
```

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 出错 |
| 2 | `review` 有 blocker（CI 用；功能未实现前不要提前编退出码语义） |
| 3 | 无数据（空暂存区、空范围、用户取消 commit） |

默认：报告写 `<repo>/.git-agent/reports/YYYY-MM/`，终端一行摘要。`--stdout` 打全文；`--json` 打结构化对象。`--dry-run` 打印 prompt、不调 API。

## 代码风格

- 文件 kebab-case；类型 PascalCase（接口不加 `I`）；函数 camelCase；常量 `UPPER_SNAKE`；Feature id = CLI 命令名。
- 单文件 ≤ 250 行，函数 ≤ 60 行。超了就拆，不要先加抽象层。
- 可预期失败一律 `new GitAgentError(code, message, hint?)`。
- `ts-morph` 只允许 `optionalDependencies` + 动态 `import()`，缺了降级正则。
- 不要引入：p-limit、inquirer/prompts、axios、打包器、新的 UI/状态库。并发用已有 `mapWithConcurrency`；交互用已有 `interactive.ts`（`node:readline`）。
- 不为第二个实现还不存在的东西抽 `BaseXxx`。

## 测试

单测放 `packages/core/test/`，与 src 同构。Git / LLM 用假 Provider，不打真实仓库、不联网。必测优先：`diff/parser`（CRLF、重命名、二进制、多 hunk）、`diff/splitter`、`redact/rules`、`config/loader`（四层合并）、`prompt/loader`、`llm/budget`。

## 改代码时

先读被改文件和调用链。公共 `Feature` / `GitProvider` / `ResolvedConfig` 只加可选字段，不要删已有键。Prompt 模板是产品的一部分，改 `prompts/**/*.md` 等于改行为。细节算法（分片、反向搜索、指纹）不要在 AGENTS.md 里发明第二套——去 architecture.md §5。
