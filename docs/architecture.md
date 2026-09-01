# git-agent-toolkit 系统架构设计

> 版本 v1.0 ｜ 日期 2026-09-01 ｜ 架构师 高见远
> 上游输入：`git-agent-toolkit-方案设计.md` v1.1（方案决策已定稿，本文档只做**落地细化**）
> 目标读者：实现工程师。本文档应能做到"照着写，不需要再问"。

---

## 0. 本文档与方案文档的关系

| 方案文档 | 本文档 |
|---|---|
| 决定**做什么、为什么** | 决定**文件怎么分、接口长什么样、按什么顺序写** |
| §3 目录结构（骨架） | 补全到 104 个文件，每个文件给出职责 + 导出签名 |
| §3.2 `Feature` 接口（5 个方法） | 保留原形状，补 2 个可选方法（见 §0.1） |
| §4/§5 功能与难点（思路） | 落成具体算法、函数签名、阈值、降级路径 |

### 0.1 对方案 `Feature` 接口的 2 处最小补充（不推翻，只补）

方案 §3.2 的 `buildSteps(data, ctx): PromptStep[]` 是静态数组，但 `review` 的 **Pass B（汇总）输入依赖 Pass A（分片）的输出**，静态数组表达不了。因此做两处补充，均为**可选**，简单功能（`commit`/`weekly`）完全用不到：

1. `PromptStep` 定义为**可辨识联合** `SingleStep | MapStep`，`buildUser / buildUserItem` 接收 `results: StepResults`（前序步骤结果）。pipeline 按数组顺序执行，声明仍是一次性静态给出。
2. 新增可选 `reduce?(results, data, ctx): O` —— 把多步结果合成最终输出。**不提供时默认取最后一个步骤的结果**，所以单步功能无需实现。

另有一处签名修正：`render(output, ctx)` → `render(output, ctx, data)`。原因：**报告里的统计数字（文件数 / 增删行数 / commit 数）必须来自 git 事实，绝不能让模型算**（方案 §4.3 防杜撰硬约束第 2 条）。渲染层需要 `data.stats` 才能拿到真实数字。

---

## 1. 技术栈与理由

### 1.1 选型

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.9（strict）+ **ESM**（`"type": "module"`, `module: NodeNext`） | 依赖（`openai@7` / `zod@4`）已是 ESM 优先；Node 22 原生支持 |
| 运行时 | Node ≥ 22 | 用户本机 v22.22.2；原生 `fs/promises`、结构化 clone 够用 |
| Monorepo | **npm workspaces**（非 pnpm） | 用户机器可能没装 pnpm，npm 零额外安装成本，降低上手门槛 |
| 构建 | `tsc` 直出 `dist`（**不做 bundle**） + `tsx` 直接跑 TS 调试 | 个人工具不需要打包器；tsc 直出便于定位堆栈 |
| CLI 参数 | `commander` | 注册表自动生成命令需要可靠的 `--help` / 子命令分组，手写不划算 |
| Git | `simple-git` | 跨平台封装了 spawn/编码/CRLF 细节，比裸 `child_process` 省事 |
| LLM | `openai` SDK（OpenAI 兼容协议） | 方案 §6 已定：DeepSeek 提供 OpenAI 兼容端点 |
| 结构化 | `zod` v4（内置 `z.toJSONSchema()`） | 一个包同时做「运行时校验」+「生成 JSON Schema 给 LLM」，不需要额外 `zod-to-json-schema` |
| 配置 | `js-yaml` + zod partial 校验 | `.git-agent/config.yml` 是人写的，必须校验并给出友好报错 |
| 路径匹配 | `picomatch` | 实现 `ignorePaths` / `blockedPaths` 的 glob |
| 符号解析 | `ts-morph`（**optionalDependencies + 动态 import**） | 方案 §5.2「先用 ts-morph 做轻量解析，避免过度设计」，且必须可缺席 |
| 终端配色 | `picocolors` | 1KB，自动识别非 TTY 不输出颜色（Windows 兼容好） |
| 测试 | `vitest` | 与 ESM/TS 零配置集成 |

### 1.2 依赖清单（版本已通过 `npm view` 核实，2026-09-01）

```jsonc
// packages/core/package.json  dependencies
"openai":        "^7.8.0",
"simple-git":    "^3.36.0",
"zod":           "^4.5.4",
"js-yaml":       "^5.4.1",
"picomatch":     "^4.0.7",
"dotenv":        "^17.4.2",
// optionalDependencies（懒加载，缺了自动降级）
"ts-morph":      "^28.0.0"

// packages/cli/package.json  dependencies
"commander":     "^15.0.0",
"picocolors":    "^1.1.1",
"@git-agent/core": "*"      // workspace 内部依赖

// 根 package.json  devDependencies
"typescript":    "^5.9.3",
"tsx":           "^4.23.13",
"vitest":        "^4.1.11",
"@types/node":   "^26.4.0"
```

> **刻意不引入**：p-limit（并发控制手写 15 行即可）、prompts/inquirer（交互用 `node:readline` 30 行）、zod-to-json-schema（zod v4 内置）、axios/got（LLM 走 openai SDK，无需 HTTP 库）。

### 1.3 架构分层

```
┌───────────────────────────────────────────────────────────────┐
│ packages/cli     命令解析 · 上下文组装 · 交互 · 退出码 · 钩子   │  薄，全部逻辑在 core
├───────────────────────────────────────────────────────────────┤
│ features/        7 个 Feature（注册制，核心零改动可扩展）       │
│ features/shared/ 4 个命令共用的采集器 + prompt 片段工厂         │
├───────────────────────────────────────────────────────────────┤
│ pipeline        collect → buildSteps → LLM → zod → reduce      │  唯一编排者
├───────────────────────────────────────────────────────────────┤
│ prompt/  llm/  diff/  git/  cache/  config/  redact/  render/  output/ │  基础设施
└───────────────────────────────────────────────────────────────┘
        ↑ @git-agent/core 是纯 TS 包：禁止 import vscode / DOM / 任何 UI 相关 API
```

---

## 2. 完整文件列表

> 约定：`路径` 列相对仓库根。`导出` 列是最主要的公开签名（省略 `Promise` 包裹的次要重载）。
> 所有文件**单文件 ≤ 250 行**，超了就拆 —— 这是硬约束，评审时检查。

### 2.1 仓库根

| 路径 | 职责 | 主要导出 / 内容 |
|---|---|---|
| `package.json` | npm workspaces 根；统一脚本 | scripts: `build`(workspaces) / `dev`(tsx 跑 CLI) / `test` / `link` |
| `tsconfig.base.json` | 公共编译选项 | `target: ES2022`, `module/moduleResolution: NodeNext`, `strict: true`, `declaration: true`, `sourceMap: true` |
| `.gitignore` | 忽略 `node_modules` `dist` `.env` `.git-agent/cache` `.git-agent/reports` | — |
| `.env.example` | `DEEPSEEK_API_KEY=sk-xxx` 示例 | — |
| `README.md` | 安装、7 个命令示例、如何加新功能（§8.6 的 3 步） | — |
| `scripts/copy-assets.mjs` | 构建时把 `packages/core/prompts/` 拷到 `dist/prompts/`（纯 Node 实现，避免 Windows 的 `cp` 差异） | 可执行脚本 |

### 2.2 `packages/core` 基础设施（`src/`）

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `package.json` | 包名 `@git-agent/core`；`bin` 无；`exports` 指向 `dist/index.js`；`files: ["dist"]` | — |
| `tsconfig.json` | 继承 base，`rootDir: src`, `outDir: dist` | — |
| `src/index.ts` | 统一出口：类型 + 工厂 + registry | 重导出全部公共 API |
| `src/types.ts` | 全局共享类型：`RepoInfo` / `ProgressEvent` / `Logger` / `ExitCode` 等（见 §3.1） | types |
| `src/errors.ts` | 错误体系：`GitAgentError`（带 `code`）+ 错误码常量 | `class GitAgentError extends Error { code: ErrorCode; hint?: string }`, `ErrorCode`, `isGitAgentError(e)` |
| `src/logger.ts` | 分级日志，**一律写 stderr**（stdout 留给报告全文 / JSON） | `createLogger(level: LogLevel): Logger` |
| `src/paths.ts` | Windows 路径工具：git 输出统一转 posix、大小写不敏感比较、路径 sanitize | `toPosix(p)`, `safeBranchName(b)`, `relativeTo(root,p)`, `samePath(a,b)` |
| `src/util/async.ts` | `sleep` + 并发映射（自写，不引 p-limit） | `sleep(ms)`, `mapWithConcurrency<T,R>(items, limit, fn)` |
| `src/util/text.ts` | 文本小工具：CRLF 归一、按行切分、截断 | `normalizeEol(s)`, `truncateLines(s, n)` |

### 2.3 `src/git/`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/git/types.ts` | `GitProvider` 接口 + 相关数据结构 | `interface GitProvider`（见 §3.2）, `RepoInfo`, `LogOptions`, `GrepHit` |
| `src/git/cli-provider.ts` | 基于 `simple-git` 的实现；**唯一发起 git 进程的地方** | `createGitProvider(cwd: string): Promise<GitProvider>` |
| `src/git/index.ts` | 转出口 | — |

**`GitProvider` 方法清单**（实现要求见 §6.4 git 调用铁律）：
`getRepoInfo()` / `resolveRef(ref)` / `getMergeBase(base, head?)` / `getBranchDiff(base, head?)` / `getStagedDiff()` / `getLog(opts)` / `getRecentSubjects(n)` / `getFileAt(ref, path)` / `listRepoFiles()` / `searchText(re, opts)` / `commit(message)` / `installHook(name, script)` / `uninstallHook(name)`

### 2.4 `src/diff/`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/diff/parser.ts` | unified diff 文本 → 结构化 `FileChange[]`（按 `\r?\n` 切行，兼容 CRLF） | `parseDiff(text: string): FileChange[]`, `serializeDiff(files: FileChange[]): string` |
| `src/diff/filter.ts` | 路径黑白名单（picomatch）、生成文件识别、二进制剔除、脱敏阻断 | `filterFiles(files, rules): FilterResult` |
| `src/diff/splitter.ts` | **分级策略 + 分片**（方案 §5.1，算法见 §5.1） | `estimateTokens(s)`, `gradeScale(tokens, cfg)`, `splitIntoChunks(files, cfg)`, `buildOutline(files, stats)` |
| `src/diff/enricher.ts` | **上下文补全**（方案 §5.2）：抓取被改函数完整定义 / 类型 / 调用方；ts-morph 懒加载 + 正则降级 | `createEnricher(git, cfg): Promise<Enricher>` |
| `src/diff/reverse-search.ts` | **反向符号搜索**（方案 §4.6）：导出符号提取 → 引用扫描 → 影响判定 → 上溯 maxDepth 层 | `extractChangedSymbols(files)`, `reverseSearch(git, symbols, opts)` |
| `src/diff/index.ts` | 转出口 | — |

### 2.5 `src/llm/`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/llm/types.ts` | `LLMProvider` 接口 + 请求/响应结构 + 模型档位枚举 | `interface LLMProvider`, `LLMRequest`, `LLMResponse`, `ModelTier`, `ThinkingMode` |
| `src/llm/deepseek.ts` | DeepSeek 适配器（openai SDK；`thinking` / `reasoning_effort` 参数；JSON Output） | `createDeepSeekProvider(cfg): LLMProvider` |
| `src/llm/budget.ts` | token 粗估 + 预算校验 + 按 hunk 边界安全截断 | `estimateTokens(s)`, `withinBudget(t, max)`, `truncateToBudget(text, max)` |
| `src/llm/retry.ts` | 重试与指数退避（**不做熔断状态机**） | `withRetry<T>(fn, opts): Promise<T>` |
| `src/llm/index.ts` | 工厂：按 `cfg.llm.provider` 建 provider | `createLLMProvider(cfg, logger)` |

### 2.6 `src/prompt/`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/prompt/loader.ts` | 读 `prompts/**.md` + `{{var}}` 替换 + shared 片段注入；定位 `dist/prompts`（dev 时回退 `src/../prompts`） | `loadPrompt(name, vars?)`, `loadShared(...names)`, `promptRoot()` |
| `src/prompt/layout.ts` | **缓存友好布局**（方案 §5.6）：稳定前缀在前、易变内容在后 | `composePrompt(opts): { system: string; user: string }` |
| `src/prompt/index.ts` | 转出口 | — |

### 2.7 `src/render/` `src/cache/` `src/config/` `src/redact/` `src/output/`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/render/markdown.ts` | Markdown 片段助手：表格、标题、严重度图标映射 | `mdTable(rows, headers)`, `mdHeading(lvl, text)`, `severityIcon(s)` |
| `src/render/json.ts` | `--json` 输出序列化（含 stats / meta 包装） | `toJsonEnvelope(featureId, output, data, usage)` |
| `src/render/index.ts` | 转出口 | — |
| `src/cache/disk-cache.ts` | 磁盘 KV 缓存，落 `.git-agent/cache/<ns>/<sha1>.json`，带 TTL | `createDiskCache(root, opts): DiskCache` |
| `src/cache/index.ts` | 转出口 | — |
| `src/config/types.ts` | 配置 TS 接口（用户配置全可选；`ResolvedConfig` 全必填） | `GitAgentConfig`, `ResolvedConfig` |
| `src/config/defaults.ts` | 方案 §7 的完整默认值 + 本文档新增的 `diff` / `cache` 两节 | `DEFAULT_CONFIG: ResolvedConfig` |
| `src/config/schema.ts` | zod **partial** schema：校验用户写的 yml，报错定位到字段 | `ConfigSchema`, `validateConfig(raw): {ok, data} \| {ok:false, errors[]}` |
| `src/config/loader.ts` | 四层合并：defaults → `~/.git-agent/config.yml` → `<repo>/.git-agent/config.yml` → CLI 覆盖；加载 `DEEPSEEK_API_KEY` | `loadConfig(opts): Promise<ResolvedConfig>` |
| `src/config/index.ts` | 转出口 | — |
| `src/redact/rules.ts` | 脱敏正则规则表（密钥 / Token / JWT / 私钥 / 内网域名 / 手机号 / 身份证）+ 路径黑名单 | `REDACT_RULES`, `DEFAULT_BLOCKED_PATTERNS` |
| `src/redact/redactor.ts` | 应用规则：文本替换 + 路径阻断判定 | `createRedactor(cfg, logger): Redactor` |
| `src/redact/index.ts` | 转出口 | — |
| `src/output/writer.ts` | 报告落盘路径生成 + 写文件（UTF-8，LF）+ 终端一行摘要 | `resolveOutputPath(cfg, repoRoot, featureId, opts)`, `writeReport(content, outPath)`, `printSummary(line, path)` |
| `src/output/index.ts` | 转出口 | — |

### 2.8 `src/features/`（注册中心 + 执行管道 + 7 个功能）

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `src/features/registry.ts` | **Feature 接口定义 + 注册表**（方案 §3.2，见 §0.1 补充） | `interface Feature`, `FeatureContext`, `PromptStep`, `ParamDef`, `register(f)`, `getFeature(id)`, `listFeatures()` |
| `src/features/pipeline.ts` | **唯一编排者**：按序执行 steps（map 并发）→ zod 校验 → reduce | `runPipeline<O>(feature, data, ctx): Promise<PipelineResult<O>>` |
| `src/features/index.ts` | 导入并注册全部 7 个 Feature；`registerAll()` | `registerAll()` |
| `src/features/shared/collect-branch.ts` | **5 个命令共用**的分支 diff 采集（含缓存指纹、过滤、分级、补全） | `collectBranchDiff(ctx, opts): Promise<CollectedData>` |
| `src/features/shared/collect-staged.ts` | `commit` 专用：暂存区 diff + 最近 N 条 subject | `collectStaged(ctx, opts): Promise<CollectedData>` |
| `src/features/shared/collect-log.ts` | `weekly` 专用：本周 log（`--all` + 作者 + 时间窗 + numstat） | `collectWeekLog(ctx, opts): Promise<CollectedData>` |
| `src/features/shared/prompt-blocks.ts` | 共用 prompt 片段：diff 正文、commit 列表、stats 表、模块 context、团队 rules | `blockDiff(d, chunkId?)`, `blockCommits(d)`, `blockStats(d)`, `blockModuleContext(ctx)`, `blockTeamRules(ctx)` |
| `src/features/shared/steps.ts` | 共用 step 工厂：分片 map step、汇总 step | `chunkMapStep(cfg, opts)`, `summaryStep(cfg, opts)` |
| `src/features/commit/{index,schema}.ts` | P0 提交信息生成（单次 flash + non-think，3 候选，确认后提交） | `commitFeature: Feature` |
| `src/features/weekly/{index,schema}.ts` | P0 周报（`--note` / `--note-file` / 编辑器） | `weeklyFeature: Feature` |
| `src/features/weekly/history.ts` | 找上一期周报（延续风格 + 兑现上周计划） | `findLastWeeklyReport(root): Promise<string \| null>` |
| `src/features/review/{index,schema}.ts` | P1 代码审查（A 分片 / B 汇总 / C 交叉检查） | `reviewFeature: Feature` |
| `src/features/test-plan/{index,schema}.ts` | P1 测试计划（A 提取变更点 / B 排优先级） | `testPlanFeature: Feature` |
| `src/features/impact/{index,schema}.ts` | P2 影响面分析（复用 `diff/reverse-search.ts`） | `impactFeature: Feature` |
| `src/features/pr-desc/{index,schema}.ts` | P2 PR 描述（复用 review / test-plan 结果缓存） | `prDescFeature: Feature` |
| `src/features/pr-desc/template.ts` | 按序探测 PR 模板，命中即用，否则内置默认 | `resolvePrTemplate(git, cfg): Promise<{source, text}>` |
| `src/features/spec/{index,schema}.ts` | P3 技术方案反推（决策痕迹提取） | `specFeature: Feature` |

### 2.9 `packages/core/prompts/`（Prompt 是一等公民，全部 `.md`）

| 路径 | 说明 |
|---|---|
| `prompts/shared/anti-hallucination.md` | **全局硬约束**（方案 §4.3 四条），被所有功能的 system prompt 注入 |
| `prompts/shared/output-format.md` | 输出格式通用要求（Markdown 视图 + JSON 视图双输出、`[推断]` 标注、`待补充` 占位） |
| `prompts/shared/severity-scale.md` | **严重度分级标准写死**（方案 §4.1 注）：什么算阻断 / 重要 / 建议 / 吹毛求疵 |
| `prompts/commit/{system,draft}.md` | system = 角色 + 规范 + 约束；draft = 用户侧模板（含 `{recentSubjects}` `{diff}`） |
| `prompts/weekly/{system,draft}.md` | system = 归纳规则；draft = 含 `{commits}` `{notes}` `{lastReport}` |
| `prompts/review/{system,chunk,summary,cross-file}.md` | system（稳定前缀）/ chunk（分片分析）/ summary（汇总定级）/ cross-file（交叉检查） |
| `prompts/test-plan/{system,extract,plan}.md` | system / extract（提取变更点）/ plan（推导用例 + P0-P2 分级） |
| `prompts/impact/{system,draft}.md` | system / draft（含 `{symbols}` `{directRefs}` `{indirectRefs}`） |
| `prompts/pr-desc/{system,draft}.md` | system / draft（含 `{template}` `{reviewSummary}`） |
| `prompts/pr-desc/default-template.md` | 内置默认 PR 模板（兜底） |
| `prompts/spec/{system,draft}.md` | system / draft（决策痕迹提取 + 反事实论证） |

### 2.10 `packages/cli`

| 路径 | 职责 | 主要导出 |
|---|---|---|
| `package.json` | 包名 `git-agent-toolkit`，`bin: { "git-agent": "bin/git-agent.js" }` | — |
| `tsconfig.json` | 继承 base，`outDir: dist` | — |
| `bin/git-agent.js` | 3 行 shebang 入口：`#!/usr/bin/env node` + `import('../dist/index.js').then(m => m.main())` | — |
| `src/index.ts` | 主入口：建 ctx → 注册命令（从 registry 自动生成）→ 解析 argv → 派发 → 退出码 | `main()` |
| `src/context.ts` | 组装 `FeatureContext`（config / git / llm / logger / cache / redactor / onProgress） | `buildContext(argv): Promise<FeatureContext>` |
| `src/register-commands.ts` | 遍历 registry，为每个 Feature 生成 commander 子命令 + 参数 + `--help` | `registerCommands(program, ctxFactory)` |
| `src/interactive.ts` | 单行交互（`node:readline`，不做全屏 TUI）：选择候选 / 确认 / 打开编辑器 | `selectOne(msg, items)`, `confirm(msg)`, `editInEditor(initial)` |
| `src/terminal.ts` | Windows 终端编码检测（GBK 提示 `chcp 65001`）、TTY 判断 | `checkTerminal()`, `isTty()` |
| `src/exit.ts` | 退出码映射与统一出口 | `exitWith(code, msg?)`, `EXIT = {OK:0, ERR:1, BLOCKER:2, NO_DATA:3}` |
| `src/commands/config.ts` | `git-agent config init`（生成 `.git-agent/config.yml` + `context/` 模板 + `~/.git-agent/rules.md`） | `configCommand` |
| `src/commands/hooks.ts` | `git-agent hooks install/uninstall`（写 `.git/hooks/prepare-commit-msg`） | `hooksCommand` |
| `src/commands/cache.ts` | `git-agent cache clear/stats` | `cacheCommand` |
| `src/commands/ask.ts` | `git-agent ask "<需求>"`：让模型从 registry 挑一个 Feature + 参数，展示后确认执行 | `askCommand` |

---

## 3. 核心数据结构

### 3.1 全局类型（`src/types.ts`）

```ts
/** 退出码：0 成功 / 1 出错 / 2 发现阻断项（CI 用） / 3 无数据 */
export type ExitCode = 0 | 1 | 2 | 3;
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface RepoInfo {
  root: string;                 // 绝对路径，posix 分隔符
  branch: string;               // 当前分支；detached HEAD 时为 'HEAD'
  headSha: string;
  isDirty: boolean;
  author: { name: string; email: string } | null;   // git config user.*
}

export interface ProgressEvent {
  phase: 'collect' | 'enrich' | 'llm' | 'render' | 'write';
  message: string;
  current?: number;
  total?: number;
}

export interface Logger {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  child(prefix: string): Logger;
}

/** 任务级汇总（写入报告尾部与 --json 的 usage 字段） */
export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;   // 前缀缓存命中部分（DeepSeek 返回则填，否则 0）
  elapsedMs: number;
}
```

### 3.2 Git 层（`src/git/types.ts`）

```ts
export interface GitProvider {
  getRepoInfo(): Promise<RepoInfo>;
  resolveRef(ref: string): Promise<string>;                 // ref → sha，不存在则抛 REF_NOT_FOUND
  getMergeBase(base: string, head?: string): Promise<string>;
  /** ⚠️ 内部必须用三点语法：git diff <base>...<head> */
  getBranchDiff(base: string, head?: string): Promise<{ text: string; numstat: string }>;
  getStagedDiff(): Promise<{ text: string; numstat: string; isEmpty: boolean }>;
  getLog(opts: LogOptions): Promise<CommitInfo[]>;
  getRecentSubjects(n: number): Promise<string[]>;
  getFileAt(ref: string, path: string): Promise<string | null>;   // 读 base/head 版本文件内容
  listRepoFiles(): Promise<string[]>;                              // git ls-files，已天然排除 ignored
  searchText(pattern: RegExp, opts?: { paths?: string[]; maxHits?: number }): Promise<GrepHit[]>;
  commit(message: string): Promise<void>;   // ★ 全项目唯一写操作，仅 commit 命令调用
  installHook(name: string, script: string): Promise<void>;
  uninstallHook(name: string): Promise<void>;
}

export interface LogOptions {
  all?: boolean;                 // weekly 用 --all（本周可能切过多个分支）
  authors?: string[];
  since?: string;                // ISO 或 git 可读日期（'last monday'）
  until?: string;
  maxCount?: number;
  withNumstat?: boolean;
  range?: string;                // 如 'origin/main..HEAD'
}

export interface CommitInfo {
  sha: string; shortSha: string;
  author: string; email: string;
  date: string;                  // ISO 8601
  subject: string; body: string;
  branch?: string;
  files?: { path: string; add: number; del: number }[];   // --numstat
}

export interface GrepHit { path: string; line: number; text: string; }
```

### 3.3 Diff 层（`src/types.ts` + `src/diff/*`）

```ts
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  oldNo: number | null;
  newNo: number | null;
  text: string;                  // 不含 +/- 前缀
}

export interface Hunk {
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  context?: string;              // @@ 行尾的函数上下文（有助于定位被改函数）
  lines: DiffLine[];
}

export interface FileChange {
  path: string;                  // posix
  oldPath?: string;              // 重命名场景
  status: FileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isGenerated: boolean;          // lock / dist / *.min.js / __snapshots__ 等
  language: string | null;       // 由扩展名推断：ts / tsx / js / css / md ...
  hunks: Hunk[];
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  byExt: Record<string, { files: number; additions: number; deletions: number }>;
}

export type DiffScale = 'small' | 'medium' | 'large';

export interface DiffChunk {
  id: string;                    // 'c0' / 'c1' ...
  module: string;                // 分片代表目录（用于日志与报告署名）
  paths: string[];
  text: string;                  // 该片的 unified diff
  estTokens: number;
}

/** 上下文补全产物：path → 追加给模型的片段文本 */
export type EnrichmentMap = Record<string, string>;
```

### 3.4 采集结果（`CollectedData`）—— 缓存的单位

```ts
export type CollectKind = 'branch-diff' | 'staged-diff' | 'log-range';

export interface CollectedData {
  kind: CollectKind;
  fingerprint: string;           // 缓存键（构造规则见 §5.4）
  repo: RepoInfo;
  base?: string;                 // branch-diff 才有
  head?: string;
  mergeBase?: string;
  files: FileChange[];           // 过滤后
  diffText: string;              // 过滤后的完整 unified diff
  stats: DiffStats;
  commits: CommitInfo[];
  scale: DiffScale;
  chunks: DiffChunk[];
  enriched: EnrichmentMap;
  extra: Record<string, unknown>;   // feature 私有：如 test-plan 的已有测试清单、pr-desc 的模板
  degraded: string[];               // 降级说明（如 'ts-morph 不可用，符号解析退化为正则'）
}
```

### 3.5 Feature 注册中心（`src/features/registry.ts`）

```ts
export type ModelTier = 'fast' | 'strong';            // → cfg.llm.model.fast / .strong
export type ThinkingMode = 'off' | 'high' | 'max';    // → non-think / high / max
export type StepResults = Record<string, unknown>;    // key = step.id

interface StepBase<S> {
  id: string;
  label?: string;                                     // 进度条显示名
  system: string;                                     // 稳定前缀（见 §5.6 prompt 布局）
  schema: ZodType<S>;
  model?: ModelTier;                                  // 默认 'fast'
  thinking?: ThinkingMode;                            // 默认由 cfg.llm.reasoningEffort 决定
  maxOutputTokens?: number;
  /** 返回 false 则跳过该步（如 review 的 cross-file 仅在文件数 > 3 时跑） */
  runIf?(results: StepResults, data: CollectedData): boolean;
}

export interface SingleStep<S = unknown> extends StepBase<S> {
  kind: 'single';
  buildUser(results: StepResults, data: CollectedData, ctx: FeatureContext): string;
}

export interface MapStep<S = unknown> extends StepBase<S> {
  kind: 'map';
  /** 返回要并行处理的条目（如 chunks，或 large 模式下模型挑出的重点文件） */
  mapOver(results: StepResults, data: CollectedData): unknown[];
  buildUserItem(item: unknown, index: number, results: StepResults, data: CollectedData, ctx: FeatureContext): string;
  concurrency?: number;                               // 默认 cfg.llm.concurrency
}
export type PromptStep = SingleStep<any> | MapStep<any>;

export type ParamSchema = ParamDef[];
export interface ParamDef {
  flag: string;                                       // '--note <text>'
  description: string;
  type: 'string' | 'boolean' | 'number' | 'string[]';
  default?: unknown;
}

export interface FeatureContext {
  repo: RepoInfo;
  git: GitProvider;
  llm: LLMProvider;
  config: ResolvedConfig;
  logger: Logger;
  redactor: Redactor;
  cache: DiskCache;
  onProgress: (e: ProgressEvent) => void;
}

export interface Feature<I = unknown, O = unknown> {
  id: string;                    // 命令名，如 'review'
  name: string;                  // 中文名
  description: string;           // 一行，进入 --help
  params: ParamSchema;           // 驱动 CLI 参数解析与 --help
  /** 1. 采集（结果自动进缓存） */
  collect(ctx: FeatureContext, input: I): Promise<CollectedData>;
  /** 2. 组装 prompt 步骤（静态声明，pipeline 按序执行） */
  buildSteps(data: CollectedData, ctx: FeatureContext): PromptStep[];
  /** 3. 可选：把多步结果合成最终输出；不提供 = 取最后一个 step 的结果 */
  reduce?(results: StepResults, data: CollectedData, ctx: FeatureContext): O;
  /** 4. 输出结构（校验 + 生成 JSON Schema 给 LLM） */
  outputSchema: ZodType<O>;
  /** 5. 渲染（data 提供真实统计数字，禁止让模型算） */
  render(output: O, ctx: FeatureContext, data: CollectedData): string;
  /** 6. 可选：退出码（review 有阻断项 → 2） */
  exitCode?(output: O): ExitCode;
}

const registry = new Map<string, Feature<any, any>>();
export function register(f: Feature<any, any>): void;
export function getFeature(id: string): Feature<any, any> | undefined;
export function listFeatures(): Feature<any, any>[];
```

### 3.6 执行管道（`src/features/pipeline.ts`）

```ts
export interface PipelineResult<O> {
  output: O;
  results: StepResults;
  usage: UsageTotals;
}

/** 按序执行 steps：map 步并发 → 每步 LLM 调用前脱敏 → zod 校验（失败重试 1 次并带上错误）→ reduce */
export async function runPipeline<O>(
  feature: Feature<any, O>,
  data: CollectedData,
  ctx: FeatureContext,
): Promise<PipelineResult<O>>;
```

### 3.7 LLM 层（`src/llm/types.ts`）

```ts
export interface LLMRequest {
  system: string;                // 稳定前缀（rules + schema + few-shot）
  user: string;                  // 易变内容（diff / log / note）—— 永远放最后
  tier?: ModelTier;              // 'fast' | 'strong'，默认 'fast'
  model?: string;                // 显式覆盖（--model）
  thinking?: ThinkingMode;
  maxOutputTokens?: number;
  jsonSchema?: unknown;          // z.toJSONSchema(schema)
  meta?: { featureId: string; stepId: string };   // 仅用于日志与用量归因
}

export interface LLMResponse {
  text: string;                  // JSON 模式下的 JSON 字符串
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
}
```

### 3.8 配置（`src/config/types.ts`）

```ts
export interface ResolvedConfig {
  version: 1;
  repoRoot: string;              // 运行时注入，不来自 yml
  configPaths: string[];         // 实际加载到的配置文件（用于 -v 打印）
  git: { defaultBase: string; includeAuthors: string[] };
  review: { ignorePaths: string[]; focusDimensions: string[]; contextPaths: string[] };
  testPlan: { priorityLevels: ('P0'|'P1'|'P2')[]; detectExisting: boolean; focus: string[] };
  impact: { maxDepth: number; symbolParser: 'ts-morph' | 'grep'; includeTests: boolean };
  prDesc: { templatePaths: string[]; includeReviewSummary: boolean };
  commit: {
    convention: 'conventional' | 'angular' | 'custom';
    types: string[]; maxSubjectLength: number; learnFromLog: number; candidates: number;
    hooks: { enabled: boolean; skipEnvVar: string };
  };
  llm: {
    provider: 'deepseek';
    model: { fast: string; strong: string };
    reasoningEffort: 'non-think' | 'high' | 'max';
    maxInputTokens: number;      // 默认 120000（方案 §7）
    chunkTargetTokens: number;   // 新增，默认 24000 —— 单片目标上限
    concurrency: number;         // 默认 3
    timeoutMs: number;           // 新增，默认 120000
    maxRetries: number;          // 新增，默认 2
  };
  security: { redact: boolean; blockedPaths: string[] };
  output: { dir: string; format: 'markdown' | 'html' | 'json'; language: string };
  // ↓ 实现必需、方案 §7 未覆盖的两节（已在 §7.1 说明理由）
  diff: {
    smallThresholdTokens: number;   // 默认 8000（方案 §5.1）
    largeThresholdTokens: number;   // 默认 60000
    enrichThresholdLines: number;   // 默认 30 —— 单文件改动超过此行数才做上下文补全
    enrichMaxTokens: number;        // 默认 20000 —— 补全总量上限
  };
  cache: { enabled: boolean; maxAgeDays: number; dir: string };   // 默认 true / 7 / '.git-agent/cache'
}
```

### 3.9 缓存与输出

```ts
// src/cache/disk-cache.ts
export interface DiskCache {
  read<T>(ns: string, key: string): Promise<T | null>;   // ns: 'collect' | 'result'
  write<T>(ns: string, key: string, value: T): Promise<void>;
  clear(ns?: string): Promise<number>;                   // 返回清理条数
  stats(): Promise<{ entries: number; sizeBytes: number }>;
}

// src/output/writer.ts
export function resolveOutputPath(cfg: ResolvedConfig, repoRoot: string,
  featureId: string, opts?: { out?: string; branch?: string; ext?: string }): string;
// 默认：<repoRoot>/<cfg.output.dir>/YYYY-MM/<branch>-<featureId>-<YYYYMMDD-HHmm>.md
// 分支名中的 '/' 替换为 '-'，Windows 非法字符剔除
```

---

## 4. 程序调用流程

以 `git-agent review --base origin/main` 为例（最复杂的路径：含缓存、分级、分片、map-reduce、落盘、退出码）。

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant CLI as cli/index.ts
    participant REG as features/registry
    participant CTX as cli/context.ts
    participant CFG as config/loader
    participant GIT as git/cli-provider
    participant CA as cache/disk-cache
    participant COL as shared/collect-branch
    participant PAR as diff/parser+filter
    participant SPL as diff/splitter
    participant ENR as diff/enricher
    participant FEAT as features/review
    participant PIPE as features/pipeline
    participant PRM as prompt/loader+layout
    participant DS as llm/deepseek
    participant ZD as zod schema
    participant OUT as output/writer

    U->>CLI: git-agent review --base origin/main
    CLI->>REG: registerAll()
    REG-->>CLI: review/test-plan/impact/... 7 个 Feature
    CLI->>REG: getFeature('review')
    CLI->>CTX: buildContext(argv)
    CTX->>CFG: loadConfig({cwd, cliOverrides})
    CFG-->>CTX: ResolvedConfig（defaults → 全局 → 仓库 → CLI）
    CTX->>GIT: createGitProvider(cwd)
    CTX-->>CLI: FeatureContext{repo,git,llm,config,logger,redactor,cache,onProgress}

    Note over CLI,COL: ── 阶段 1：采集（可缓存）
    CLI->>FEAT: collect(ctx, {base:'origin/main', head:'HEAD'})
    FEAT->>COL: collectBranchDiff(ctx, {base, head})
    COL->>GIT: resolveRef('origin/main') / resolveRef('HEAD')
    COL->>GIT: getMergeBase(base, head)
    GIT-->>COL: mergeBase sha
    COL->>COL: fingerprint = sha1(mergeBase + headSha + filterRules)
    COL->>CA: read('collect', 'branchdiff:'+fingerprint)
    alt 缓存命中且未 --no-cache
        CA-->>COL: CollectedData
        COL-->>FEAT: CollectedData（日志：命中采集缓存）
    else 未命中
        COL->>GIT: getBranchDiff(base, head)
        Note right of GIT: git diff base...head（三点语法，铁律）
        GIT-->>COL: {text, numstat}
        COL->>PAR: parseDiff(text) → FileChange[]
        COL->>PAR: filterFiles(files, {ignorePaths, blockedPaths})
        PAR-->>COL: 过滤后 files + stats
        COL->>SPL: estimateTokens(diffText) → gradeScale()
        SPL-->>COL: scale = small | medium | large
        COL->>SPL: splitIntoChunks(files, cfg)
        SPL-->>COL: DiffChunk[]（同目录/同模块聚合）
        opt scale != small
            COL->>ENR: enrich(改动行数 > 阈值 的文件)
            Note right of ENR: 懒加载 ts-morph；不可用则正则降级
            ENR-->>COL: EnrichmentMap
        end
        COL->>CA: write('collect', fingerprint, CollectedData)
        COL-->>FEAT: CollectedData
    end
    FEAT-->>CLI: CollectedData

    Note over CLI,PIPE: ── 阶段 2：组装 + LLM（map-reduce）
    CLI->>PIPE: runPipeline(reviewFeature, data, ctx)
    PIPE->>FEAT: buildSteps(data, ctx)
    FEAT->>PRM: loadPrompt('review/system'|'chunk'|'summary'|'cross-file', vars)
    PRM-->>FEAT: 模板文本
    FEAT-->>PIPE: [outline?] → chunk(MapStep) → summary → cross-file

    loop 按序执行每个 step（runIf=false 则跳过）
        alt kind = 'map'（Pass A 分片分析）
            PIPE->>PIPE: mapWithConcurrency(chunks, cfg.llm.concurrency)
            par 每片一次调用
                PIPE->>PRM: composePrompt({instructions, rules, schema, fewShot, variable: chunkText})
                Note right of PRM: 稳定前缀在前，diff 最后（吃前缀缓存）
                PRM-->>PIPE: {system, user}
                PIPE->>DS: complete({tier:'fast', thinking:'off', jsonSchema})
                DS->>DS: withRetry（429/5xx/超时，指数退避，最多 2 次）
                DS-->>PIPE: LLMResponse(text, usage)
                PIPE->>ZD: schema.safeParse(JSON.parse(text))
                alt 校验失败
                    PIPE->>DS: 重试 1 次（prompt 追加「上次错误：<issues>」）
                    DS-->>PIPE: LLMResponse
                end
                ZD-->>PIPE: 该片问题列表
            end
        else kind = 'single'（Pass B 汇总 / Pass C 交叉检查）
            PIPE->>PRM: composePrompt({... variable: 前序步骤结果})
            PRM-->>PIPE: {system, user}
            PIPE->>DS: complete({tier:'strong', thinking:'high'})
            DS-->>PIPE: LLMResponse
            PIPE->>ZD: safeParse → 汇总结果
        end
        PIPE->>CLI: onProgress({phase:'llm', current, total})
    end

    PIPE->>FEAT: reduce(results, data, ctx)
    FEAT-->>PIPE: ReviewOutput{overview, intent, issues[], crossFile[], highlights[], questions[]}
    PIPE-->>CLI: PipelineResult{output, results, usage}

    Note over CLI,OUT: ── 阶段 3：渲染 + 落盘
    CLI->>FEAT: render(output, ctx, data)
    Note right of FEAT: 统计数字取自 data.stats（模型不算数）
    FEAT-->>CLI: Markdown 全文
    CLI->>OUT: resolveOutputPath(cfg, root, 'review', {branch})
    OUT-->>CLI: .git-agent/reports/2026-09/main-review-20260901-1430.md
    CLI->>OUT: writeReport(md, path)（UTF-8 / LF / 递归建目录）
    CLI->>U: ✓ 审查完成：2 阻断 / 5 重要 / 11 建议<br/>  → 报告路径
    CLI->>CLI: exitCode = output 有 blocker ? 2 : 0
    CLI-->>U: process.exit(code)
```

### 4.1 其余命令的流程差异（一句话）

| 命令 | 与 review 的差异 |
|---|---|
| `commit` | `collect-staged` → 无分片 → 单个 `fast`/`off` step → 交互选候选 → 确认后 `git.commit()`；失败静默退出 0（仅 `--prefill` 模式） |
| `weekly` | `collect-log`（`--all` + 时间窗）→ 读 `--note`/`--note-file`/编辑器 + 上周周报 → 单个 `strong`/`high` step → 落盘 |
| `test-plan` | 复用 `collect-branch`（**同指纹命中同一份缓存**）→ `extract`(map, fast) → `plan`(single, fast) |
| `impact` | 复用 `collect-branch` → **本地** `extractChangedSymbols` + `reverseSearch`（不调 LLM）→ 单个 `strong`/`high` 判定 step |
| `pr-desc` | 复用 `collect-branch` → 探测模板 → 读缓存里已有的 review/test-plan 结果 → 单个 `strong`/`high` step |
| `spec` | 复用 `collect-branch` → `outline`(strong) → `draft`(map over 重点文件, strong) → `final`(single, strong) |

---

## 5. 关键难点的落地方案

### 5.1 大 diff 分级策略（`src/diff/splitter.ts`）

```ts
export function estimateTokens(s: string): number {
  // 粗估即可，宁可高估：ASCII 约 4 字符/token，CJK 约 1.5 字符/token，另加行开销
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.5 + countLines(s) * 0.5);
}

export function gradeScale(tokens: number, cfg: ResolvedConfig): DiffScale {
  if (tokens < cfg.diff.smallThresholdTokens)  return 'small';   // < 8K
  if (tokens <= cfg.diff.largeThresholdTokens) return 'medium';  // 8K ~ 60K
  return 'large';                                                 // > 60K
}
```

| 规模 | 处理 | 分片规则 |
|---|---|---|
| `small` | 单次全量，1 片 | — |
| `medium` | 按模块分片 → 并行 map → 汇总 | 见下方 `splitIntoChunks` |
| `large` | **结构摘要先行**：先发「文件清单 + 每个文件一行 numstat 摘要」让模型挑重点文件（`outline` step，pro+high），再对重点文件深挖分片；其余文件走摘要级审查 | 重点文件按模块分片；非重点文件合并为 1 片「摘要级」 |

**`splitIntoChunks(files, cfg)` 算法**（保证"同目录/同模块同片"）：

1. 按路径的**前 2 层目录**分组（`src/hooks/a.ts` → `src/hooks`；根目录文件归入 `.`）。
2. 组内按 `additions + deletions` 降序排列（改动大的先占片）。
3. 顺序装桶：累加 `estTokens`，超过 `chunkTargetTokens` 则开新桶。
4. **单个文件就超过 `chunkTargetTokens`** 时，按 hunk 边界切该文件（不切断行），保证每片 ≤ 预算。
5. 桶太碎（< 3 个文件且 token 很少）时与相邻组合并，减少调用次数。

> `chunkTargetTokens` 默认 24000，与 `maxInputTokens`（120000）的关系：单片 24K + system 前缀约 4K，留足输出与重试空间；`maxInputTokens` 是**总预算硬闸**，pipeline 在发出每片前用 `withinBudget` 校验，超了就降级为摘要级。

### 5.2 上下文补全（`src/diff/enricher.ts`）

补全优先级（方案 §5.2）：① 被改函数/类的完整定义（base 版 + head 版）② 相关类型/接口声明 ③ 直接调用方 ④ 同目录约定性文件（`index.ts` / `constants.ts`）。

```ts
export interface Enricher {
  /** path → 追加给模型的片段（已拼好 markdown，带文件头与行号） */
  enrich(files: FileChange[], opts: { maxTokens: number }): Promise<EnrichmentMap>;
  mode: 'ts-morph' | 'regex';    // 实际生效的模式，写进 CollectedData.degraded
}
export async function createEnricher(git: GitProvider, cfg: ResolvedConfig): Promise<Enricher>;
```

- **触发条件**：单文件 `additions + deletions > cfg.diff.enrichThresholdLines`（默认 30）。
- **总量控制**：按改动行数从大到小处理，累计 tokens 达 `cfg.diff.enrichMaxTokens`（默认 20000）即停。
- **懒加载 ts-morph**（铁律）：
  ```ts
  let morph: typeof import('ts-morph') | null = null;
  try { morph = await import('ts-morph'); } catch { morph = null; }   // 未装 → 直接走 regex
  ```
- **regex 降级实现**：`getFileAt('HEAD', path)` 取全文 → 从 hunk 行号向上找最近的 `export (async)? (function|const|class|interface|type)` 起点 → 大括号配平截取定义块 → 类型声明用 `/(interface|type)\s+\w+/` 在头 200 行内找 → 调用方用 `searchText(new RegExp('\\b' + name + '\\b'))` 取前 20 条。
- **失败不阻塞**：单个文件补全抛错 → 记 warn 日志 + 写进 `degraded`，继续跑。

### 5.3 反向符号搜索（`src/diff/reverse-search.ts`，`impact` 专用）

```ts
export type SymbolKind = 'function' | 'class' | 'type' | 'const' | 'component' | 'unknown';
export interface SymbolChange {
  path: string; name: string; kind: SymbolKind;
  change: 'added' | 'modified' | 'removed';
  signature?: string;                  // 有则带上，供模型判签名变化
  hunkLine?: number;
}
export interface ReferenceHit {
  path: string; line: number; text: string;
  symbol: string;                      // 命中的符号名
  depth: number;                       // 1 = 直接，2 = 间接
  via?: string;                        // depth=2 时的中间符号
}
export interface ReverseSearchResult {
  symbols: SymbolChange[];
  direct: ReferenceHit[];
  indirect: ReferenceHit[];
  mode: 'ts-morph' | 'grep';
  truncated: boolean;                  // 命中数超上限被截断
}

export function extractChangedSymbols(files: FileChange[]): SymbolChange[];
export async function reverseSearch(
  git: GitProvider, symbols: SymbolChange[],
  opts: { maxDepth: number; includeTests: boolean; mode: 'ts-morph' | 'grep' },
): Promise<ReverseSearchResult>;
```

**执行步骤**
1. **提符号**：从每个 `+/-` 行用正则提取 `export (default)? (async function|function|const|class|interface|type|enum)` 后的标识符；删掉状态的文件直接取其导出名。去重后按文件聚合。
2. **扫引用**：
   - `mode: 'grep'`（默认，零依赖）：`git.listRepoFiles()` 拿清单 → 排除 `node_modules`/`dist`（`ls-files` 已排除）→ 逐个文件读 + 正则 `\b<name>\b` 匹配，记录行号与原文。
   - `mode: 'ts-morph'`：`Project` + `getSourceFiles` + `findReferences`（更准，但需装包且大仓库慢；装了才用）。
   - **上限保护**：扫描文件数上限 4000，单符号命中上限 200，超出置 `truncated: true`。
3. **上溯**：depth=1 命中文件中若**重新导出或封装**了该符号（如 `export { useSupervisionForm }`、`export function useXxx(){ return useSupervisionForm() }`），再对**新符号名**做一轮扫描得到 depth=2。循环次数 = `min(maxDepth, 2)`，**禁止更深**（防指数爆炸）。
4. **判定"是否真受影响"交给模型**（`strong` + `high`）：本地只负责把 `signature` + 命中行原文喂给它；模型判不了的输出 `[待确认]`，不硬编。
5. **退化**：ts-morph 不可用 → `mode: 'grep'`，并在报告「说明」段写明降级（方案 §10 风险对策）。

### 5.4 采集缓存（方案 §8.5）

**指纹构造**

| 采集类型 | fingerprint |
|---|---|
| `branch-diff` | `sha1(mergeBase + ':' + headSha + ':' + hash(ignorePaths + blockedPaths + enrichThresholdLines))` |
| `staged-diff` | `sha1('staged:' + hash(git diff --staged 原文))` |
| `log-range` | `sha1(since + ':' + until + ':' + authors.join() + ':' + headSha)` |

**存储**：`.git-agent/cache/collect/<sha1>.json`（内容 = `CollectedData` 序列化，`chunks`/`enriched` 也一起存，避免重复计算）。
**复用范围**：`review` / `test-plan` / `impact` / `pr-desc` / `spec` 五个命令用**同一个 `branch-diff` 指纹**，所以跑第二个命令零额外采集成本。
**LLM 结果缓存**（`pr-desc` 复用 review 结论用）：`.git-agent/cache/result/<featureId>:<fingerprint>.json`，只在 `--with-review` 等场景读写，`--no-cache` 时全部跳过。
**失效**：`maxAgeDays`（默认 7）过期自动忽略；`git-agent cache clear` 手动清。缓存读取失败（JSON 损坏）视为未命中，**绝不抛错**。

### 5.5 CLI 输出约定

```
默认：写文件 + 终端一行摘要
  ✓ 审查完成：2 阻断 / 5 重要 / 11 建议
    → .git-agent/reports/2026-09/main-review-20260901-1430.md
--stdout：额外把全文打到 stdout（供管道消费）
--json：stdout 输出 {feature, generatedAt, stats, output, usage}，不写 md（除非同时给 --out）
```

| 退出码 | 触发条件 |
|---|---|
| 0 | 成功（含 review 无阻断项） |
| 1 | 运行出错（配置错 / git 错 / LLM 最终失败 / 无 API Key） |
| 2 | 成功但 `review` 发现 blocker 级问题（CI 卡流水线） |
| 3 | 无数据（暂存区为空、指定范围无 commit、过滤后无文件） |

- `-v`：打印模型、分片数、每步 token、缓存命中情况（走 logger → stderr）。
- 检测到 Windows GBK 终端（`chcp` 非 65001）时，warn 一次并**仍然写文件**——不因编码问题失败。

### 5.6 Prompt 布局铁律（`src/prompt/layout.ts`）

```ts
export function composePrompt(o: {
  instructions: string;   // feature 的 system.md
  rules: string;          // 团队 rules.md + 模块 context（稳定）
  schema: string;         // JSON Schema 文本（稳定）
  fewShot?: string;       // 稳定
  variable: string;       // ★ 易变：diff / log / note —— 永远最后
}): { system: string; user: string }
// system = instructions + rules + schema + fewShot（跨分片完全一致 → 命中前缀缓存）
// user   = variable
```

- 分片 map 时，`system` 由 `buildSteps` 计算一次并复用同一个字符串对象，确保字节完全一致（前缀缓存命中的前提）。
- 所有 prompt 注入 `prompts/shared/anti-hallucination.md`（方案 §4.3 四条硬约束）。

### 5.7 脱敏（`src/redact/`）

- `--redact` / `security.redact` **默认 `true`**（基础规则）：`sk-` 前缀密钥、`AKIA`、GitHub `ghp_/gho_`、JWT、PEM 私钥块、`Authorization: Bearer xxx`、内网域名（`*.internal` / `*.corp` / 10.x/192.168.x IP）、中国大陆手机号、身份证号。
- 邮箱默认**不脱敏**（git 元数据需要），可用 `security.redactEmails` 开启（新增项）。
- **路径黑名单**（`security.blockedPaths`：`.env*` `**/*secret*`）命中的文件**整体从 diff 中剔除**，并在报告「说明」段列出剔除数量（不列路径，避免泄露）。
- 脱敏发生在两处：① 采集后写缓存前（**缓存里存的已是脱敏后内容**）② pipeline 发请求前（双保险，成本极低）。
- `--dry-run`：把所有 step 的 `{system, user}` 完整打印到 stdout 并退出 0，**不调用 API**。

---

## 6. 共享知识（跨文件约定，工程师必须遵守）

### 6.1 命名约定

| 对象 | 规则 | 例 |
|---|---|---|
| 文件 / 目录 | kebab-case | `reverse-search.ts` |
| 类型 / 接口 / 类 | PascalCase，接口**不加 `I` 前缀** | `GitProvider` |
| 函数 / 变量 | camelCase | `collectBranchDiff` |
| 常量 | UPPER_SNAKE | `DEFAULT_CONFIG` |
| Feature id | kebab-case，等于 CLI 命令名 | `test-plan` |
| prompt 变量 | `{{camelCase}}` | `{{recentSubjects}}` |
| zod schema | `<Name>Schema` | `ReviewOutputSchema` |

### 6.2 错误处理约定

1. **只用 `GitAgentError`** 表达可预期失败：
   ```ts
   throw new GitAgentError('NO_API_KEY', '未检测到 DEEPSEEK_API_KEY', '在 ~/.git-agent/.env 或环境变量中配置');
   ```
   错误码枚举（`src/errors.ts`）：`CONFIG_INVALID` / `NO_API_KEY` / `NOT_A_REPO` / `REF_NOT_FOUND` / `GIT_FAILED` / `NO_DATA` / `LLM_FAILED` / `LLM_SCHEMA_INVALID` / `FS_FAILED` / `HOOK_FAILED`。
2. **分层职责**：
   - 底层（git / fs / llm）只抛错，不打印、不 `process.exit`。
   - LLM 调用统一包 `withRetry`（429 / 5xx / ETIMEDOUT / ECONNRESET 重试，指数退避 800ms→1600ms，最多 2 次）；仍失败抛 `LLM_FAILED`，**不做熔断状态机**。
   - Feature 内部：采集到空数据 → 抛 `NO_DATA`（CLI 转退出码 3）。
   - **只有 `cli/src/index.ts` 的顶层 `main()` 可以 `process.exit`**，其余地方一律返回值/抛错。
3. **`commit` 钩子模式特殊**：`--prefill` 下任何错误都吞掉 → 打一行 debug 日志 → 退出 0，**绝不阻塞用户提交**。
4. 缓存读写、上下文补全、模块 context 加载，全部**失败即降级**，绝不中断主流程。

### 6.3 路径处理约定

1. 内部一律 **posix 分隔符**（`/`），git 输出与配置 glob 都在入口处 `toPosix()` 归一。
2. 拼接路径只用 `node:path` 的 `join/resolve/relative`；跨系统比较用 `samePath()`（Windows 下大小写不敏感）。
3. 报告文件名中的分支名必须 `safeBranchName()`（`feature/xxx` → `feature-xxx`，剔 `<>:"|?*`）。
4. 写文件固定 **UTF-8 + LF**（`\n`），不依赖平台默认编码。
5. 解析 git 输出按 `\r?\n` 切行（Windows CRLF）。

### 6.4 git 调用铁律

1. **分支对比一律三点语法** `git diff <base>...<head>`（等价于 `git diff $(git merge-base base head) head`）。**禁止两点语法** —— 两点会把 base 上别人新合入的内容算成"你的删除"。
2. 本分支 commit 列表用 `git log <base>..<head>`（两点，这是 log 的正确用法，与 diff 不同）。
3. 所有 git 调用集中在 `src/git/cli-provider.ts`，**其他文件禁止 spawn git**。
4. `simple-git` 统一配置：`{ maxConcurrentProcesses: 6, trimmed: false }`，二进制 diff 加 `--binary` 之外一律不带（避免大输出）。
5. 输出可能很大时（diff / log）走 `git.raw([...])` 拿完整 stdout，不做 `trim`。

### 6.5 日志约定

- 日志**只写 stderr**（`console.error`），stdout 留给报告全文与 JSON。
- 级别：`-v` → debug；默认 info（只打进度与结果摘要）；`--quiet` → silent。
- 进度用 `onProgress` 事件 → CLI 渲染为 `⏳ 分析分片 2/5`；非 TTY 环境不打印进度（避免刷屏）。
- 禁止在库文件里 `console.log`。

### 6.6 代码风格

- 单文件 **≤ 250 行**；函数 ≤ 60 行；圈复杂度高的地方拆函数。
- 每个导出符号有一行 JSDoc（写"做什么"，不写"怎么做"）。
- 异步统一 `async/await`，禁止回调函数。
- 禁止 `any` 泛滥；确实需要处写 `// eslint-disable-next-line` + 一句原因注释（本项目不配 eslint，靠自觉）。
- **不为假想需求写抽象层**：不要 `BaseXxx` / `AbstractFactory`；只有第二个实现出现时才抽接口。

### 6.7 模型选型表（写死在 `src/llm/deepseek.ts` 的常量映射里）

| 场景 | tier | thinking |
|---|---|---|
| `commit`（格式转换，延迟敏感） | `fast` | `off` |
| `test-plan` 两遍 | `fast` | `off` |
| `review` Pass A 分片分析 | `fast` | `off` |
| `review` Pass B 汇总 / Pass C 交叉检查 | `strong` | `high` |
| `impact` 影响判定 | `strong` | `high` |
| `pr-desc` | `strong` | `high` |
| `spec` 全部步骤 | `strong` | `high` |
| `weekly` | `strong` | `high` |
| `review` large 模式的 `outline` 挑重点 | `strong` | `high` |

> `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 废弃，**代码中禁止出现**；模型 id 只在 `config/llm/model/{fast,strong}` 两处出现。

### 6.8 测试约定（vitest）

- 单测放 `packages/core/test/**.test.ts`，与 src 同构。
- 必测纯函数：`diff/parser`（CRLF、重命名、二进制、多 hunk）、`diff/splitter`（三级阈值、超预算单文件切分）、`redact/rules`、`config/loader`（四层合并）、`prompt/loader`（变量替换）、`llm/budget`。
- Git 相关用**假 Provider**（实现 `GitProvider` 接口的内存版），不打真实仓库。
- LLM 相关用**假 Provider**，不联网。

---

## 7. 待明确事项

| # | 事项 | 我的默认假设（如无异议照此实现） | 需要用户确认？ |
|---|---|---|---|
| 1 | **代码外发合规**：日常开发仓库的 diff 能否发到 DeepSeek 外部 API | 假设**可以**（个人工具定位）；`--redact` 默认开 + 路径黑名单兜底 | **是，开工前必须确认**（方案 §11 第 1 条） |
| 2 | 报告是否需要推送到飞书/钉钉/邮件 | 假设**不需要**，只落本地 Markdown | 否（保持只读 + 本地，符合方案 §8.4） |
| 3 | 个人使用还是团队共享 | 假设**个人**：全局配置 `~/.git-agent/`，仓库配置 `.git-agent/` | 否 |
| 4 | 仓库形态（单仓 / monorepo） | 假设**单仓**；分片按"前 2 层目录"聚合，monorepo 下天然按 package 聚片，够用 | 否 |
| 5 | commit 规范 | 假设 **Conventional Commits**（方案 §7 已定），`types` 可配 | 否 |
| 6 | 是否要 CI 集成 | 假设**暂不**，但退出码 2 / `--json` 按方案 §2.3 做扎实，将来直接可用 | 否 |
| 7 | `weekly` 的时间窗 | 默认**本周一 00:00 ~ 现在**；`--since/--until` 可覆盖 | 否 |
| 8 | 配置新增项（`diff:` / `cache:` / `llm.chunkTargetTokens` 等） | 已在 §3.8 标注，均为实现必需，方案 §7 未覆盖 | 否（属实现细节） |
| 9 | `ts-morph` 是否安装 | 默认放 `optionalDependencies`，**不强制**；没装则 enricher / impact 自动正则降级 | 否 |
| 10 | DeepSeek 价格 / 模型 id 变更 | 模型 id 集中在 `config.llm.model` 两处；价格不进代码 | 否 |
