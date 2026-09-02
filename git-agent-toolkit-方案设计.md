# git-agent-toolkit 方案设计文档

> 版本：v1.1 ｜ 日期：2026-09-01
> 目标：基于 DeepSeek 构建一个 **CLI 形态** 的可扩展 Git 工作流工具箱，落地七个能力：
> **代码 Review、技术方案反推、周报、提交信息、测试计划、影响面分析、PR 描述**。

---

## 0. 一句话结论

**做成 CLI（`git-agent <cmd>`），核心能力放在与宿主无关的 `@git-agent/core` 里。**

CLI 是**唯一交付形态**；VSCode 插件 / DeepSeek Harness 插件 / MCP Server 只作为未来可选薄壳，不在当前计划内。

| | 结论 |
|---|---|
| **交付形态** | **CLI**（npm 包 `git-agent-toolkit`，命令 `git-agent`；也可 `git agent <cmd>` 调用） |
| 核心包 | `@git-agent/core` —— 纯 TS，不 import 任何 `vscode` / DOM API |
| 一期功能（7 个） | `review` `spec` `weekly` `commit` `test-plan` `impact` `pr-desc` |
| 未来可选 | VSCode 插件 / DSH 插件 / MCP Server —— 都只是 < 200 行薄壳，core 一行不改 |
| 扩展机制 | 三层可插拔：Feature（功能）/ Provider（数据源·模型）/ Renderer（输出） |

**为什么是 CLI**：七个功能的价值 90% 来自 git 数据采集 + diff 加工 + prompt 工程，这三件事跟界面毫无关系。而 CLI 还额外带来三样插件形态给不了的东西：

1. **可脚本化 / 可进 CI** —— 想在 PR 流水线里自动出报告，只有 CLI 做得到。
2. **可挂 git 钩子** —— `commit` 命令必须靠 `prepare-commit-msg` 钩子才有意义，这是插件形态做不到的。
3. **跨编辑器复用** —— 换编辑器、换电脑、`ssh` 到服务器上都能用。

### 七个功能一览

| 命令 | 一句话 | 数据切片 × 视角 | 阶段 |
|---|---|---|---|
| `git-agent commit` | 暂存区 diff → 规范的 commit message | diff(暂存区) × 生成 | **P0** |
| `git-agent weekly` | 本周 commit → 周报（可加人工补充） | log × 归纳 | **P0** |
| `git-agent review` | 分支 diff → 结构化审查报告 | diff × 审查 | P1 |
| `git-agent test-plan` | 分支 diff → 测试计划与用例清单 | diff × 生成 | P1 |
| `git-agent impact` | 分支 diff → 变更影响面分析 | diff × 预测 | P2 |
| `git-agent pr-desc` | 分支 diff → PR / MR 描述 | diff × 生成 | P2 |
| `git-agent spec` | 分支 diff → 技术方案文档 | diff × 反推 | P3 |

**为什么这个顺序**：`commit` 和 `weekly` 都不需要分片、不需要上下文补全，是验证"LLM 链路 + git 采集"最快的路径；`review` 最难（要分片、要上下文、要降误报），所以先拿简单的把链路跑通，再啃硬的。

---

## 1. 需求拆解

| 需求 | 输入 | 处理 | 输出 |
|---|---|---|---|
| 代码 Review | 开发分支 vs 目标分支的 diff | 分片分析 → 汇总 → 交叉检查 | 结构化审查报告（Markdown） |
| 技术方案反推 | 同上 | 意图推断 → 决策痕迹提取 → 成文 | 技术方案文档（Markdown） |
| 周报 | 本周全部 commit（跨分支） | 聚类 → 归纳工作项 → 合并人工补充 | 周报（Markdown） |
| 提交信息 | **暂存区** diff | 学习团队风格 → 生成候选 | 3 个候选 commit message |
| 测试计划 | 分支 diff | 提取变更点 → 推导场景 → 排优先级 | 测试计划与用例清单 |
| 影响面分析 | 分支 diff + 反向符号搜索 | 找引用方 → 判断是否需同步改 | 受影响清单 + 回归路径 |
| PR 描述 | 分支 diff + commit + PR 模板 | 按模板填充（复用 review 结果） | PR / MR 描述 |

**七者共享同一条数据链路**，差异只在 prompt 与输出模板：

```
git 采集 → diff 解析/过滤 → 上下文补全 → 分片 → prompt 组装 → LLM → 结构化解析 → 渲染
   ✅共享                      ✅共享        ✅共享                      ❌各异        ✅共享
```

这意味着：采集层做一次，七个功能受益；**多个命令共用同一份采集缓存**（见 §8.5），跑第二个命令不额外花钱。

### 设计原则

1. **Core 与 UI 彻底解耦** —— core 是纯 Node/TS 库，不 import 任何 `vscode` / DOM API。
2. **Feature 注册制** —— 新功能 = 新增一个实现 `Feature` 接口的文件 + 一行注册，零改动核心。
3. **Prompt 是一等公民** —— 独立成 `.md` 文件而非硬编码在 TS 里，可版本化、可灰度、可 A/B。
4. **绝不杜撰数据** —— 所有量化结论必须可溯源到 git 数据或用户输入；推断内容显式标注 `[推断]`，无法确定的写"待补充"。（见 §4.3 硬约束，对全部七个功能生效）
5. **成本不是瓶颈，上下文才是** —— 见 §5.6，别过度优化 token。
6. **只做只读分析 + 产出文档** —— 唯一的例外是 `commit`，它只在用户明确确认后才调用 `git commit`，见 §4.4。

---

## 2. 形态决策：CLI

### 2.1 决策：CLI 为唯一交付形态

| 维度 | VSCode 插件 | DeepSeek Harness 插件（DSH） | **CLI（选定）** |
|---|---|---|---|
| 上手成本 | 中（打包、调试、发布） | 中（需理解 Cordis 插件模型） | **低（npm link 即用）** |
| 可脚本化 / CI 集成 | 弱 | 弱 | **强** |
| 可挂 git 钩子 | 否 | 否 | **强（`commit` 命令的前提）** |
| 跨编辑器 / 跨机器复用 | 否（锁 VSCode） | 否（锁 DSH） | **是** |
| 稳定性风险 | 低 | **高（0.1.x 预览，API 会变）** | 低 |
| 可视化 diff 浏览 | **强（原生红绿高亮）** | 中（Web UI） | 弱（需输出到文件） |
| 基建复用 | 需自己写 UI | **强（trajectory / sandbox / subagent 现成）** | 需自己写 |

**结论**：CLI 赢在"能被自动化"和"不绑定任何东西"，而它的唯一弱点（可视化）对我们影响有限——本工具箱产出的是**文档报告**，不是需要逐行对照的改动建议。报告写进 Markdown 文件，用 VSCode 打开就是原生红绿高亮。

### 2.2 关于 DeepSeek Harness：调研过，暂不采用

- MIT 开源，`npx @deepseek-ai/dsh web` 即可启动，默认 `http://127.0.0.1:3080`。
- 架构：**Cordis 插件容器，"everything is a plugin"** —— 模型、工具、skills、sandbox、session、loop、UI 全部可插拔替换。
- 四种运行模式：Standard / Code（PTC，用 TypeScript 编排多步工具调用）/ Minimal / Creation。
- 自带 **append-only session log + Trajectory 视图**：系统提示、推理、工具调用、上下文注入全部留痕，可 resume / fork / replay。

**不采用的理由**：基建确实诱人，但它 2026-08 才开预览（0.1.x），官方明确警告会有破坏性变更。把核心逻辑写进 DSH 插件 = 把资产押在一个会变的 API 上。正确姿势是 **core 独立**——将来真要接，写个薄适配层（约 200 行）即可，届时成本极低、风险为零。

### 2.3 CLI 命令设计

```
git-agent <command> [options]

分析命令
  commit          生成 commit message（读暂存区，可选直接提交）
  weekly          生成周报（--note / --note-file 补充非代码内容）
  review          代码审查报告
  test-plan       测试计划与用例建议
  impact          变更影响面分析
  pr-desc         PR / MR 描述
  spec            技术方案反推

辅助命令
  config init     生成 .git-agent/config.yml 与 rules 模板
  hooks install   安装 prepare-commit-msg 钩子（--uninstall 卸载）
  ask "<需求>"    自然语言入口：由模型挑一个功能并展示将用的参数
  cache clear     清理采集缓存
```

#### 全局参数（所有分析命令通用）

| 参数 | 说明 |
|---|---|
| `--base <ref>` | 目标分支，默认取配置 `git.defaultBase` |
| `--head <ref>` | 开发分支，默认 `HEAD` |
| `--out <path>` | 输出路径；默认 `.git-agent/reports/YYYY-MM/<分支>-<命令>-<时间>.md` |
| `--stdout` | 同时打印全文到终端（默认只写文件，见下方输出约定） |
| `--model <id>` | 覆盖默认模型（如临时升级到 v4-pro） |
| `--json` | 输出结构化 JSON，便于脚本消费 |
| `--dry-run` | 只输出将发送的 prompt，不调用 API（合规审查用） |
| `--no-cache` | 跳过采集缓存，强制重新采集 |
| `-v` | 打印 token 消耗、分片数等调试信息 |

#### 输出约定

1. **默认写文件**，不依赖终端渲染 —— 这是 Windows GBK 终端下的正确做法（见 §5.7）。
2. 终端只回一行摘要 + 路径：
   ```
   ✓ 审查完成：2 阻断 / 5 重要 / 11 建议
     → .git-agent/reports/2026-09/feature-supervision-review.md
   ```
3. `--stdout` 才打印全文；检测到非 UTF-8 终端时提示先执行 `chcp 65001`。
4. 需要交互的场景（`commit` 选候选、确认提交）用轻量单行 prompt，不做全屏 TUI。

#### 退出码（便于 CI 使用）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行出错 |
| **2** | **成功，但审查发现阻断项** —— CI 可用它卡住流水线 |
| 3 | 无变更 / 无数据（如暂存区为空） |

### 2.4 未来可选的薄壳（不在当前计划内）

core 与 UI 解耦后，将来想加形态都只是薄壳，core 一行不改：

| 薄壳 | 工作量 | 价值 |
|---|---|---|
| MCP Server | ~150 行 | Claude Code / Cursor 都能调用你的能力，生态杠杆最大 |
| VSCode 插件 | ~300 行 | 侧边栏 + 右键菜单 + Webview 报告 |
| DSH 插件 | ~200 行 | 蹭 DSH 的 trajectory 与 sandbox，待其 API 稳定后再说 |

---

## 3. 总体架构

### 3.1 目录结构

```
git-agent-toolkit/
├── packages/
│   ├── core/                      # 与宿主无关的核心（Monorepo 主包）
│   │   ├── src/
│   │   │   ├── git/               # GitProvider：diff / log / blame / merge-base
│   │   │   │   ├── git-provider.ts      # 接口定义
│   │   │   │   └── cli-provider.ts      # 基于 simple-git 的实现
│   │   │   ├── diff/
│   │   │   │   ├── parser.ts            # unified diff → 结构化 hunk
│   │   │   │   ├── filter.ts            # 路径黑白名单、生成文件过滤
│   │   │   │   ├── enricher.ts          # 上下文补全（函数体/类型/调用方）
│   │   │   │   ├── splitter.ts          # token 预算分片
│   │   │   │   └── reverse-search.ts    # 反向符号引用搜索（impact 专用）
│   │   │   ├── llm/
│   │   │   │   ├── provider.ts          # LLMProvider 接口
│   │   │   │   ├── deepseek.ts          # DeepSeek 适配器
│   │   │   │   ├── budget.ts            # token 估算与限流
│   │   │   │   └── retry.ts             # 重试 / 退避 / 熔断
│   │   │   ├── prompt/
│   │   │   │   ├── loader.ts            # 加载 md 模板 + 变量替换
│   │   │   │   └── layout.ts            # 缓存友好布局（稳定前缀在前）
│   │   │   ├── features/                # ★ 功能注册中心（7 个）
│   │   │   │   ├── registry.ts
│   │   │   │   ├── commit/              # P0
│   │   │   │   ├── weekly/              # P0
│   │   │   │   ├── review/              # P1
│   │   │   │   ├── test-plan/           # P1
│   │   │   │   ├── impact/              # P2
│   │   │   │   ├── pr-desc/             # P2
│   │   │   │   └── spec/                # P3
│   │   │   ├── render/                  # markdown / json
│   │   │   ├── cache/                   # 采集结果缓存（按 commit 指纹）
│   │   │   ├── config/                  # .git-agent/config.yml 解析
│   │   │   └── redact/                  # 敏感信息脱敏
│   │   └── prompts/                     # ★ prompt 资产（md 文件）
│   │       ├── shared/
│   │       │   ├── anti-hallucination.md   # 防杜撰硬约束（全局生效）
│   │       │   ├── output-format.md
│   │       │   └── severity-scale.md       # 严重度分级标准
│   │       ├── commit/{system,draft}.md
│   │       ├── weekly/{system,draft}.md
│   │       ├── review/{system,chunk,summary,cross-file}.md
│   │       ├── test-plan/{system,extract,plan}.md
│   │       ├── impact/{system,draft}.md
│   │       ├── pr-desc/{system,draft}.md
│   │       └── spec/{system,draft}.md
│   └── cli/                       # git-agent 命令行（唯一交付形态）
│       ├── bin/git-agent.ts
│       └── src/hooks.ts                 # prepare-commit-msg 钩子安装
└── docs/
```

> `mcp-server` / `vscode-ext` / `dsh-plugin` **暂不创建**。core 与 UI 解耦后，将来想加只是薄壳，见 §2.4。

### 3.2 扩展性核心：Feature 接口

```ts
// packages/core/src/features/registry.ts
export interface FeatureContext {
  repo: RepoInfo;
  git: GitProvider;
  llm: LLMProvider;
  config: ResolvedConfig;      // 合并了全局配置 + 仓库配置 + CLI 参数
  logger: Logger;
  onProgress: (e: ProgressEvent) => void;
}

export interface Feature<I = unknown, O = unknown> {
  /** 命令名，如 'review' */
  id: string;
  name: string;
  description: string;

  /** 声明需要的输入参数（自动驱动 CLI 参数解析与 --help 输出） */
  params: ParamSchema;

  /** 1. 采集：向 git 要数据 */
  collect(ctx: FeatureContext, input: I): Promise<CollectedData>;

  /** 2. 组装：数据 → prompt 包（可多轮，支持 map-reduce） */
  buildSteps(data: CollectedData, ctx: FeatureContext): PromptStep[];

  /** 3. 约束：输出结构（Zod schema，用于校验 + 驱动 structured output） */
  outputSchema: ZodSchema<O>;

  /** 4. 渲染：结构化结果 → Markdown / HTML */
  render(output: O, ctx: FeatureContext): string;
}

// 注册一行搞定
export const registry = new Map<string, Feature>();
export function register(f: Feature) { registry.set(f.id, f); }
```

**新增一个功能只需要**：新建 `features/xxx/index.ts` 实现接口 + `prompts/xxx/*.md` + `register(xxx)`。核心代码零改动。

---

## 4. 七大功能详细设计

> 4.1~4.3 为最初规划的三个核心功能；4.4~4.7 为新增的四个高频轻量功能。
> 全部复用 §3 的同一条采集链路，差异只在 prompt 与输出模板。
> **按实现顺序阅读**：4.4 commit → 4.3 weekly → 4.1 review → 4.5 test-plan → 4.6 impact → 4.7 pr-desc → 4.2 spec。

### 4.1 代码 Review

#### 输入采集（关键细节）

```bash
# ⚠️ 必须用三点语法：只看本分支相对 merge-base 的改动
#    若用两点语法，会把目标分支上别人新合入的内容也算成"你的删除"
git merge-base origin/main HEAD        # 得到 base commit
git diff origin/main...HEAD            # 本分支真实改动
git diff --numstat origin/main...HEAD  # 改动规模统计
git log --oneline origin/main..HEAD    # 本分支的 commit message（用于推断意图）
```

采集清单：
1. 变更文件列表 + 新增/删除行数 + 文件类型分布
2. 完整 unified diff（过滤后）
3. 本分支 commit messages（推断"这次想干什么"）
4. **上下文补全**：对改动超过阈值的文件，抓取 base 版本中对应函数/类的完整定义、相关类型声明、直接调用方（前端项目先用正则 + `ts-morph` 轻量解析，够用即可）

#### 处理流程（map-reduce）

```
[采集] → [过滤] → [上下文补全] → [分片]
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
               Pass A: 片段分析   Pass A: 片段分析   ...   (并行，每片 ≤ 预算)
                    └────────────────┼────────────────┘
                                     ▼
                        Pass B: 汇总（去重/排序/定级/结论）
                                     ▼
                        Pass C: 交叉检查（跨文件一致性、接口变更同步）
                                     ▼
                                 [渲染报告]
```

- **Pass A**：每片输出结构化问题列表（文件、行号、类型、严重度、描述、建议改法、置信度）
- **Pass B**：去重合并、按严重度排序、给出总体结论与合并建议
- **Pass C**（可选，大改动才跑）：输入文件级摘要 + 接口签名变更，检查调用方是否同步更新、是否有遗漏的错误处理

#### 输出报告结构

```markdown
# 代码审查报告：feature/xxx → main

## 概览
- 变更：12 个文件，+842 / -317；关联提交 7 个
- 结论：**建议修改后合并**（存在 2 个阻断项、5 个重要项）

## 变更意图（推断）
[推断] 本次改动旨在将督导评价模块的表单校验逻辑从组件内抽离为独立 hook……
依据：commit "refactor: 抽出 useSupervisionForm 校验逻辑" + src/hooks 新增 3 文件

## 问题清单
### 🔴 阻断（2）
1. `src/hooks/useSupervisionForm.ts:47` — useEffect 依赖项缺失 `validate`
   → 导致校验函数捕获旧 state，表单在快速输入时判断错误
   建议：加入依赖项，或改用 useCallback + 函数式更新

### 🟠 重要（5）
...

### 🟡 建议（8） / ⚪ 吹毛求疵（3）

## 架构与跨文件问题
- 新增的 `EvaluationContext` 已在 A、B 组件消费，但 C 组件仍直读旧 store，存在双写风险

## 测试与回归风险
- 改动覆盖 3 个核心校验分支，现有单测仅覆盖 1 个；建议补充边界用例

## 性能 / 安全 / 兼容性
- `EvaluationList` 未做 memo，200+ 行数据时每次输入触发全量重渲染

## 亮点
- 校验逻辑抽离后组件代码减少 40%，可测性显著提升

## 需要你确认的问题
1. 这里兼容旧数据的分支，是临时方案还是长期保留？
```

> **严重度分级标准必须写死在 `review-rules.md` 里**（什么算阻断、什么算建议），否则模型每次输出的标准都不一样。

---

### 4.2 技术方案反推

与 Review 共享采集层（可直接复用 `review` 的采集缓存），但 prompt 视角完全相反：**不问"哪里有问题"，问"这段代码解决了什么问题、为什么这么解决"**。

#### Prompt 设计要点

- 要求**区分"意图"与"实现"**：先说要解决什么问题，再说怎么实现
- 要求**提取决策痕迹**——这是本功能质量的胜负手。引导模型去找代码里的显性权衡点：
  - `// TODO / FIXME / HACK` 注释
  - feature flag、兼容分支、`try/catch` 兜底
  - 显式的性能优化（memo / 虚拟列表 / 防抖节流）
  - 数据结构的选型（为什么用 Map 而非 Array）
  - 被删掉的旧实现（说明方案演进过）
- 要求每个关键决策输出 **"如果不这么选会怎样"**（反事实论证，避免写成流水账）

#### 输出结构

```markdown
# 技术方案：督导评价表单校验重构

## 一、背景与目标
[推断] 解决的问题：表单校验逻辑散落在 3 个组件中，新增字段需改多处……
前置假设：项目已确认不再需要 IE10 兼容（依据：移除的 polyfill）

## 二、需求拆解
| 子需求 | 对应实现 | 状态 |
|---|---|---|

## 三、整体设计
### 3.1 改动前后对比
### 3.2 模块职责与依赖
### 3.3 数据流 / 调用链（含时序描述）

## 四、关键实现
- 核心数据结构、接口定义、状态流转
- 关键代码片段（带行号引用）

## 五、关键技术决策与权衡
| 决策 | 备选方案 | 选择理由 | 不这么选的后果 |
|---|---|---|---|
| 用 Context 而非引入状态库 | Redux / Zustand | 作用域仅评价模块，引入成本高于收益 | 增加包体积与学习成本 |

## 六、影响范围与兼容性
## 七、风险与遗留 TODO
## 八、验收要点
```

**产出定位**：这是"事后补写"的文档，用于复盘、交接、晋升答辩素材。所以允许模型标注 `[推断]`，但必须给出依据。

---

### 4.3 周报生成

#### 输入采集

```bash
# 注意 --all：本周可能切过多个分支开发
git log --all --author="<me>" --since="last monday" --until="now" \
        --pretty=format:"%H|%ad|%s" --date=iso --numstat
```

- 采集本周全部 commit（含 diffstat，可选带小 diff 提升归纳质量）
- 用户补充的非代码内容（会议、评审、面试、文档、协作、答疑）
- **上周周报**（用于风格延续 + 兑现上周"下周计划"）

#### 处理流程

1. 过滤噪音：merge commit、纯 lock 更新、格式化改动 —— 不删除，归入"工程维护"
2. LLM 聚类：把零散 commit 归纳成 3~6 个**工作项**（按模块/需求聚合）
3. 每个工作项输出：做了什么 → 产出/价值 → 当前状态
4. 与用户补充内容合并（人工内容优先级更高，不做改写）
5. 输出周报 + 下周计划（基于未完成线索 + 上周计划中未兑现项自动顺延）

#### 输入补充内容的三种方式

```bash
# 方式 1：命令行直接给
git-agent weekly --note "周三参加教学评价需求评审，输出评审纪要；协助新人排查构建问题"

# 方式 2：文件（适合内容多、需要复用的场景）
git-agent weekly --note-file ./this-week.md

# 方式 3：交互式（不传参数时自动打开编辑器）
git-agent weekly
```

#### 输出结构

```markdown
# 工作周报（2026.08.25 - 08.31）

## 本周概览
本周提交 23 次，涉及 4 个模块；核心产出为督导评价表单重构上线。

## 重点工作
### 1. 督导评价表单校验重构（40% 工作量）
- 将散落在 3 个组件的校验逻辑抽离为 useSupervisionForm，组件代码减少 40%
- 补充 12 个单测用例，覆盖边界场景
- 状态：已合并至 develop，待测试环境验证

### 2. CourseEvaluation 模块代码优化与单测（30%）
...

### 3. 非代码工作
- 参与教学评价需求评审，输出评审纪要（人工补充）

## 问题与解决
- 构建时 TS 类型报错：通过统一 EvaluationContext 类型定义解决

## 下周计划
1. 跟进测试环境验证反馈，修复遗留问题
2. 完成 DeepAnalysis 模块单测补齐（上周顺延）
3. [待补充]

## 需要的支持
- [待补充]
```

#### ⚠️ 防杜撰硬约束（全局生效）

以下规则写在 `prompts/shared/anti-hallucination.md`，**对所有七个功能生效**（此处以周报为例列出）：

```
1. 只使用 git 数据 与 用户提供的补充内容，禁止编造任何业务指标、人数、百分比
2. 可量化的只能来自可统计的 git 事实（提交数、文件数、增删行数）
3. 所有推断必须标注 [推断] 并说明依据
4. 信息不足时写"待补充"，禁止用合理的想象填补
```

---

### 4.4 `commit` — 提交信息生成

#### 输入采集

```bash
git diff --staged            # 只看暂存区（不看工作区未暂存的改动）
git diff --staged --stat     # 改动规模
git log -20 --pretty=%s      # 最近若干条，用于学习团队既有风格
```

#### 处理

- **单次调用，不分片**：暂存区通常不大，且本命令对延迟敏感（人就在等它）。
- 模型用 **flash + non-think**：这是"格式转换"任务，不需要深度推理。
- 输出 3 个候选（type / scope / subject / body），用户选一个或手改。
- 暂存区为空 → 提示先 `git add`，退出码 3。

#### Prompt 要点

- **从 `git log` 学习团队已有的 type 分布**（feat/fix/refactor/chore…），不要凭空发明规范。
- subject 控制在配置的长度上限内。
- **body 写"为什么"，不写"改了什么"** —— diff 已经说明了改了什么，重复没价值。
- 改动混杂多个意图时，输出候选里要明确提示"建议拆成多次提交"。

#### 输出

```
? 生成了 3 个候选（基于最近 20 条 commit 的风格）

  1) feat(supervision): 抽离表单校验逻辑为独立 hook

     校验原先散落在 3 个组件内，新增字段需同步改多处。
     抽出后组件代码减少约 40%，便于补充单测。

  2) refactor(supervision): 提取 useSupervisionForm
     ...

  3) feat(supervision): 重构督导评价表单校验
     ...

选择 [1-3] / e 编辑 / n 取消：
```

#### git 钩子集成（让这个命令真正好用）

```bash
# .git/hooks/prepare-commit-msg
#!/bin/sh
# 仅在打开编辑器（未通过 -m 传入）的场景下预填
if [ -z "$2" ] || [ "$2" = "message" ]; then
  git-agent commit --prefill --out "$1"
fi
```

- 提供 `git-agent hooks install` / `hooks uninstall` 管理。
- **钩子必须可跳过**：支持 `GIT_AGENT_DISABLE=1` 环境变量与 `--no-verify`，否则网络一慢就变成负担。
- `--prefill` 模式静默运行，失败时**绝不阻塞提交**（吞掉错误，直接退出 0）。

> ⚠️ 这是整个工具箱里**唯一会写入 git 状态**的地方（用户确认后才调 `git commit`）。除此之外全部只读。

#### 配置

```yaml
commit:
  convention: conventional        # conventional | angular | custom
  types: [feat, fix, refactor, perf, test, docs, chore, style]
  maxSubjectLength: 72
  learnFromLog: 20                # 从最近 N 条 commit 学习风格
  candidates: 3
  hooks:
    enabled: true
    skipEnvVar: GIT_AGENT_DISABLE
```

---

### 4.5 `test-plan` — 测试计划与用例建议

> 这个命令直接服务于你正在补的 CourseEvaluation 单测。

#### 输入

与 `review` 完全相同的分支 diff —— **可直接复用 review 的采集缓存**（先跑过 review 则零额外成本），外加仓库已有的测试文件清单。

#### 处理（两遍）

- **Pass A**：逐片提取"变更点"——新增/修改的条件分支、边界处理、错误路径、异步逻辑。
- **Pass B**：汇总去重，为每个变更点推导应覆盖的场景，按风险排序。

#### Prompt 要点

- 输出格式固定为「变更点 → 场景 → 优先级（P0/P1/P2）→ 测试类型（单测/集成/手工）」。
- **重点找易漏分支**：`else` 分支、`catch` 分支、空数组/空对象、`undefined`、边界值、异步竞态、重复提交。
- 通过匹配已有测试文件名与 `describe` 名称**推断现有覆盖情况**，已覆盖的不再建议，避免输出一堆废话。

#### 输出

```markdown
# 测试计划：feature/supervision-form

## 统计
变更点 9 个，建议用例 14 条（P0 5 / P1 6 / P2 3）；
其中 2 个变更点推断已被现有测试覆盖，未重复建议。

## P0 必测
| 变更点 | 场景 | 类型 |
|---|---|---|
| useSupervisionForm.ts:47 validate 依赖变更 | 快速连续输入时校验结果正确 | 单测 |
| EvaluationList.tsx:88 新增空态分支 | 列表为空时展示空态而非崩溃 | 单测 |

## P1 建议
...

## 需人工验证
- 涉及真实接口的提交流程，建议手工回归
```

**为什么这个功能值得单独做**：它是七个功能里**模型准确率最高**的一个——「改了什么就该测什么」高度客观可判定，幻觉空间小。同时它把"想清楚该测什么"这个最耗神的环节自动化了，写测试代码本身反而快。

---

### 4.6 `impact` — 变更影响面分析

#### 与 Review 的区别

| | Review | Impact |
|---|---|---|
| 问题 | 这段代码本身有没有问题 | 它会不会把别处弄坏 |
| 上下文方向 | **向前**看：被改函数依赖什么 | **向后**看：谁依赖被改的东西 |

两者**共用同一份采集结果**（见 §8.5 缓存），建议提 MR 前都跑一遍。

#### 关键实现：反向符号搜索

1. 从 diff 中提取被修改/删除的**导出符号**（函数、组件、类型、常量）。
2. 全仓搜索引用点：`grep -rn` 起步（够快、零依赖）；前端项目可切到 `ts-morph` 做精确引用解析。
3. 逐个判断该引用点是否真受影响（签名变了？默认值变了？行为变了？）。
4. 顺着引用点**最多再上溯一层**（配置 `impact.maxDepth`，默认 2），否则会指数爆炸。

#### Prompt 要点

- 区分**直接影响**（直接 import 被改符号）与**间接影响**（依赖直接影响方）。
- 每个影响点标注「是否需要同步修改」+ 理由；判断不了的标 `[待确认]`，不要硬编。
- 输出**建议回归路径**：哪些页面/流程需要人工点一遍。

#### 输出

```markdown
# 影响面分析：feature/supervision-form → main

## 变更的导出符号（5 个）
- `useSupervisionForm` — 签名变更（新增可选参数 options）
- `validateEvaluation` — 行为变更（空值不再抛错，改为返回 false）

## 直接影响（7 处）
| 位置 | 影响的符号 | 需同步改 | 说明 |
|---|---|---|---|
| pages/Supervision/Form.tsx:12 | useSupervisionForm | 否 | 新增参数可选，默认行为不变 |
| pages/DeepAnalysis/Form.tsx:30 | validateEvaluation | **是** | 原依赖抛错做兜底，需改为判断返回值 |

## 间接影响（3 处）
...

## 建议回归路径
1. 督导评价 → 新建评价 → 提交（主流程）
2. 深度分析 → 空数据场景（本次行为变更点）

## 待确认
- `validateEvaluation` 在测试文件中的 mock 是否也需同步更新？
```

---

### 4.7 `pr-desc` — PR / MR 描述生成

#### 输入

分支 diff + 本分支 commit messages + 仓库 PR 模板。

#### 处理

1. 按序探测模板，命中即用：`.git/pull_request_template.md` → `.github/PULL_REQUEST_TEMPLATE.md` → `.gitlab/merge_request_templates/Default.md` → 内置默认模板。
2. 若 `.git-agent/cache/` 里已有本次 `review` 或 `test-plan` 的结果，**直接复用**（零额外成本）。
3. 按模板填充；模板里没有的章节不硬加。

#### 输出（默认模板示例）

```markdown
## 改了什么
将督导评价表单的校验逻辑从 3 个组件中抽离为 useSupervisionForm……

## 为什么
新增字段需同步改多处，散落逻辑已成维护瓶颈
（依据：commit "refactor: 抽出 useSupervisionForm 校验逻辑"）

## 影响范围
- 直接影响 7 处，其中 1 处需同步修改（DeepAnalysis/Form.tsx）
- 详见 .git-agent/reports/2026-09/feature-supervision-impact.md

## 测试
- 新增 12 个单测用例，覆盖空值 / 边界 / 异步竞态
- 需手工回归：督导评价新建提交主流程

## 遗留与后续
- [ ] EvaluationList 未做 memo，大数据量下存在重渲染（本次未处理）
```

#### 联动

- `git-agent pr-desc --with-review` —— 自动带上 review 报告的结论与遗留项。
- 因为 `review` / `test-plan` / `impact` / `pr-desc` 共用采集缓存，**四个命令跑完只花一份采集的钱**，只有 LLM 调用各算各的。

---

## 5. 关键技术难点与解法

### 5.1 大 diff 怎么喂（分级策略）

1M 上下文"能塞下" ≠ "效果好"。塞太满会导致：首 token 延迟高、中间内容被忽略（lost-in-the-middle）、单次失败重跑代价大。

| 规模（估算 token） | 策略 |
|---|---|
| < 8K（约 500 行内改动） | **单次全量**，一次调用出结果 |
| 8K ~ 60K | **按模块分片并行** → 汇总（map-reduce） |
| > 60K | **结构摘要先行**：先给"变更文件清单 + 每个文件一句话摘要"，让模型挑出重点文件，再对重点文件深挖；其余走摘要级审查 |
| 任何规模 | 分片时**同一目录 / 同一模块的文件放在同片**，保证语义完整 |

默认 token 预算上限可配置（`llm.maxInputTokens`，默认 120K）。

### 5.2 只给 diff 不够：上下文补全

diff 只有改动的 ±3 行，模型看不到函数全貌，最容易误判。补全优先级：

1. 被修改函数的**完整定义**（base 版本 + head 版本）
2. 涉及的**类型 / 接口声明**
3. **直接调用方**（判断改动的影响面）
4. 同目录的**约定性文件**（如 `index.ts` 导出、`constants.ts`）

前端项目实现：先用 `ts-morph` 做轻量符号解析（够用且无需编译），避免过度设计。

> 以上是"向前"补全（被改函数依赖什么）。反过来"谁依赖了被改的东西"由 `diff/reverse-search.ts` 负责，见 §4.6。

### 5.3 让模型"懂业务"

模型不可能天然知道你们的业务。用三级上下文注入：

| 层级 | 文件 | 内容 |
|---|---|---|
| 团队级 | `~/.git-agent/rules.md` | 通用编码规范、严重度分级标准、输出语言 |
| 仓库级 | `.git-agent/config.yml` | 默认 base 分支、忽略路径、关注维度 |
| 模块级 | `.git-agent/context/<module>.md` | 如"督导评价"的业务含义、核心概念、字段口径 |

模块级 context 是**投入产出比最高**的一项：每个模块写 100~200 字，Review 质量提升明显。一期不需要向量库，直接拼接即可。

### 5.4 输出结构化

- 每个 Feature 声明 Zod schema，用于：① 约束模型输出 ② 校验失败自动重试一次 ③ 渲染层类型安全
- 结构化片段（问题清单、决策表）要求模型同时输出 JSON 与 Markdown 两种视图，避免渲染层二次解析出错

### 5.5 安全与脱敏（企业项目必做）

代码要发到外部 API，必须可控：

- `--redact` 开关（默认开启基础规则）：自动替换密钥、Token、内网域名、手机号、身份证
- 路径黑名单：`.env*`、`*secret*`、测试数据快照、客户名单
- 输出产物本地留存，默认不上传
- 提供 `--dry-run`：只输出会发送的 prompt，不真正调用（用于合规审查）

### 5.6 成本：别过度优化

以一次中等规模 Review（输入 40K token + 输出 4K token）估算：

| 模型 | 谷时成本 | 峰时成本 |
|---|---|---|
| deepseek-v4-flash | ≈ ¥0.08 | ≈ ¥0.16 |
| deepseek-v4-pro | ≈ ¥0.24 | ≈ ¥0.48 |

**结论：单次调用成本在"几分钱到几毛钱"量级，不是瓶颈。** 与其省 token，不如把预算花在 §5.2 的上下文补全上——那里省一块钱，质量损失值十块。

真正值得做的两个优化：
1. **缓存友好布局**：系统提示 + rules + schema + few-shot 等**稳定内容放 prompt 最前面**，diff 等易变内容放最后。DeepSeek 前缀缓存命中后输入单价可降一个数量级，一轮多片的 map-reduce 收益尤其明显。
2. **避开峰时**：峰时为 UTC 01:00–04:00 与 06:00–10:00，对应**北京时间 09:00–12:00 和 14:00–18:00（正好是上班时间）**。周报、批量审查这类可延迟任务，排到晚上跑，成本直接减半。

### 5.7 Windows 适配（你在本机的主要环境）

- 终端中文乱码：CLI 输出统一 UTF-8，检测到 GBK 终端时提示 `chcp 65001`；**默认把报告写成文件**，不依赖终端渲染
- 路径分隔符统一用 `path` 模块处理，git 输出路径统一转 `/`
- 换行符：diff 解析时按 `\r?\n` 处理
- 命令名取 `git-agent`，可同时以 `git-agent review` 和 `git agent review` 两种方式调用（git 会自动查找 PATH 中的 `git-<cmd>`）

---

## 6. DeepSeek 接入要点

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

const res = await client.chat.completions.create({
  model: 'deepseek-v4-pro',               // 或 deepseek-v4-flash
  messages: [/* 稳定前缀在前，diff 在后 */],
  thinking: { type: 'enabled' },
  reasoning_effort: 'high',               // non-think / high / max
  stream: true,
});
```

| 项 | 说明 |
|---|---|
| base_url | `https://api.deepseek.com`（也提供 Anthropic 兼容端点 `/anthropic`） |
| 模型 | `deepseek-v4-flash`（快、便宜）/ `deepseek-v4-pro`（强、3x 价格） |
| 上下文 | 1M tokens，最大输出 384K |
| Thinking | `non-think` / `think high`（默认）/ `think max` |
| ⚠️ 已下线 | `deepseek-chat`、`deepseek-reasoner` 已于 2026-07-24 废弃，**不要再使用** |
| 计费 | 分时段（谷时为峰时 5 折）+ 前缀缓存（命中显著降价） |
| 选型建议 | `commit` / `test-plan` 用 **flash + non-think**（低延迟优先）；`review` 分片分析用 **flash**；`spec` / 汇总 / 交叉检查 / `impact` 影响判断用 **pro + high** |

> 价格与模型版本迭代频繁，接入前请以 `platform.deepseek.com` 官方定价页为准。

---

## 7. 配置设计（`.git-agent/config.yml`）

```yaml
version: 1

git:
  defaultBase: origin/main        # 目标分支默认值
  includeAuthors: [ "<your-email>" ]   # 周报用

review:
  ignorePaths:                    # 一律不看
    - "**/dist/**"
    - "**/*.lock"
    - "**/pnpm-lock.yaml"
    - "**/__snapshots__/**"
  focusDimensions:                # 审查维度（驱动 prompt 组装）
    - correctness
    - performance
    - security
    - testability
    - maintainability
  # 前端可加：bundle-size / browser-compat
  contextPaths:                   # 模块业务说明
    - .git-agent/context/*.md

testPlan:
  priorityLevels: [P0, P1, P2]
  detectExisting: true            # 匹配已有测试，避免重复建议
  focus: [edge-case, error-path, async-race, empty-value]

impact:
  maxDepth: 2                     # 引用上溯层数，避免指数爆炸
  symbolParser: ts-morph          # ts-morph | grep
  includeTests: true

prDesc:
  templatePaths:                  # 按序探测，命中即用
    - .git/pull_request_template.md
    - .github/PULL_REQUEST_TEMPLATE.md
    - .gitlab/merge_request_templates/Default.md
  includeReviewSummary: true

commit:
  convention: conventional
  types: [feat, fix, refactor, perf, test, docs, chore, style]
  maxSubjectLength: 72
  learnFromLog: 20
  candidates: 3

llm:
  provider: deepseek
  model:
    fast: deepseek-v4-flash
    strong: deepseek-v4-pro
  reasoningEffort: high
  maxInputTokens: 120000
  concurrency: 3                  # 分片并行度

security:
  redact: true
  blockedPaths: [ ".env*", "**/*secret*" ]

output:
  dir: ./reports
  format: markdown                # markdown | html | json
  language: zh-CN
```

`git-agent config init` 一键生成模板 + 示例 rules。

---

## 8. 功能扩展：矩阵与候选池

### 8.1 扩展框架：数据切片 × 分析视角

不要按"还能加什么命令"来想扩展，那会变成零散功能的堆砌。真正的扩展空间是一个二维矩阵——**同一份 git 数据，换个问法就是新功能**：

- **数据切片**（行）：一次改动 `diff` ／ 一段时间 `log` ／ 单个文件 `blame` ／ 两个版本 `tag`
- **分析视角**（列）：审查（问题在哪）／解释（这是什么）／归纳（做了什么）／反推（为什么这么做）／预测（会波及什么）／生成（产出什么）

|  | 审查 | 解释 | 归纳 | 反推 | 预测 | 生成 |
|---|---|---|---|---|---|---|
| **一次改动 diff** | ✅ 代码 Review | ⚪ 代码讲解 | — | ✅ 技术方案 | ✅ 影响面分析 | ✅ 提交信息 / PR 描述 / 测试计划 |
| **一段时间 log** | ⚪ 技术债趋势 | — | ✅ 周报 | ⚪ 迭代复盘 | — | ⚪ 贡献回顾 |
| **单个文件 blame** | — | ⚪ 代码考古 | ⚪ 模块交接 | — | — | — |
| **两个版本 tag** | — | — | — | — | — | ⚪ 发布说明 |

> ✅ 一期已规划（7 个）｜ ⚪ 后续候选 ｜ — 待定义（留给未来的你）
>
> 一期占了 7 格。因为采集层已经建好，**再填一个新格子的成本 ≈ 一份 prompt + 半天工作量**。

---

### 8.2 一期新增的四个

完整设计见 §4.4 ~ §4.7，这里只记录**为什么是这四个**：

| 命令 | 为什么选它 | 成本 |
|---|---|---|
| `commit` | 写 commit message 是**最高频的摩擦**，团队还常要求 Conventional Commits 规范。flash 模型就够、单次几乎不花钱，而且人一眼能看出对不对 —— **零风险**。 | 极低 |
| `test-plan` | 「改了什么就该测什么」**客观可判定**，是七个功能里模型准确率最高的。它自动化的正是"想清楚该测什么"这个最耗神的环节，写测试代码本身反而快。 | 低 |
| `impact` | 补 Review 的**天然盲区**：Review 只看改动本身，看不到谁在依赖它。改公共组件时的刚需，目前主流工具都做得差。 | 中（需反向符号搜索） |
| `pr-desc` | 填 PR 模板枯燥，所以大家都敷衍。且能**复用 review 的采集结果**，一份采集两处产出。 | 低 |

排序依据：**痛点强度 × 实现成本 × 模型可靠性**。

---

### 8.3 后续候选（有明确场景再做）

| 命令 | 数据切片 × 视角 | 说明 |
|---|---|---|
| `explain` | diff / blame × 解释 | 接手别人代码时，解释这段改动或这个模块在干什么 |
| `blame` | 单个文件 × 解释 | 代码考古：这行为什么这么写、谁改的、关联哪个需求 |
| `standup` | 一天 log × 归纳 | 日报（周报的轻量版，同一套 prompt 换时间窗） |
| `retro` | 一段时间 log × 反推 | 迭代复盘：质量趋势、返工率、阻塞点 |
| `handover` | 单模块 × 归纳 | 模块交接文档：核心逻辑、坑点、常见改动位置 |
| `debt` | 一段时间 log × 审查 | 技术债盘点：TODO/FIXME 存量与新增趋势 |
| `changelog` | 两版本 tag × 生成 | 发布说明（面向用户的变更描述） |
| `contrib` | 一年 log × 生成 | 年度贡献回顾，输出晋升答辩 / 简历素材 |

---

### 8.4 明确不建议做的

判断什么不做，比列一堆功能更重要：

| 不做 | 原因 |
|---|---|
| **自动修复代码（fix）** | 风险与收益不成正比，且 Copilot / Cursor 已有，重复造轮子。Review 给出"建议改法"就够了，动手留给人和 IDE。 |
| **向量库 / RAG** | 一期用 rules + 模块 context 文件足够。引入向量库会把一个轻量工具变成运维负担。 |
| **通用聊天 / 代码补全** | 不是这个工具箱的赛道，做了也打不过专用产品。 |
| **自动提 PR / 自动合并** | 涉及写操作与外部副作用，不碰。 |
| **多模型路由 / 模型评测** | 除非要做成产品，否则是过度工程。留好 `LLMProvider` 接口即可。 |

**一条贯穿的原则：只做"只读分析 + 产出文档"，不自动改代码、不自动动 git 状态。** 唯一的例外是 `commit`——它只在用户逐条确认候选之后才调用 `git commit`，且失败时不阻塞（见 §4.4）。保持只读，就永远不会有"AI 把我的分支搞坏了"的恐惧，你才敢真用。

---

### 8.5 三个元能力（不是新功能，但让所有功能增值）

| 元能力 | 说明 |
|---|---|
| **产物归档** | 所有报告写入 `.git-agent/reports/YYYY-MM/`，按 `分支-功能-时间` 命名。投入极小（就是改输出路径），但价值随时间复利——年底写总结、准备面试时，能翻出全年完整记录。 |
| **采集缓存** | 采集结果按 commit 指纹缓存到 `.git-agent/cache/`。同一分支重复跑不重新采集，也不重复花钱。 |
| **`git-agent ask` 万能入口** | 用自然语言说需求，让模型从已注册 Feature 里挑一个执行，并展示它将使用的参数供你确认。有了它，功能变多之后不用记命令名。 |

---

### 8.6 加一个新功能要做什么

假设要加「**代码讲解**」（`explain`，从 §8.3 候选池里挑的）：

1. 新建 `packages/core/src/features/explain/index.ts`，实现 `Feature` 接口
2. 新建 `packages/core/prompts/explain/{system,draft}.md`
3. 在 `features/index.ts` 加一行 `register(explainFeature)`
4. 完成 —— CLI 参数、`--help` 输出、配置校验、渲染、重试、脱敏、归档、缓存全部自动继承

全程不触碰 core 任何一行，也不需要改 CLI 一行代码（命令是从注册表自动生成的）。

---

## 9. 开发路线

| 阶段 | 目标 | 产出 | 关键验收 |
|---|---|---|---|
| **P0（1~2 天）** | 打通链路 | core 骨架 + GitProvider + DeepSeek 适配器 + CLI 壳 + **`commit`** + **`weekly`** | 在自己仓库跑出 commit message，以及一份真实周报 |
| **P1（3~5 天）** | Review 落地 | diff 解析/过滤/分片 + review prompt + 报告渲染 | 拿一个真实 MR 跑通，人工评估问题命中率 |
| **P1.5（1 天）** | 测试计划 | `test-plan`（复用 review 采集层） | 输出的用例清单能直接照着写测试 |
| **P2（2~3 天）** | 质量提升 | 上下文补全 + 交叉检查 + 模块 context 文件 | 误报率明显下降 |
| **P2.5（1~2 天）** | 影响面 + PR 描述 | 反向符号搜索 `reverse-search.ts` + 模板读取 | 改公共组件时能列出全部受影响点 |
| **P3（2 天）** | 技术方案 | `spec`（复用 review 采集层） | 产出文档可直接用于复盘/答辩 |
| **P4（可选）** | 加薄壳 | MCP Server / VSCode 插件 / DSH 插件 | 各 < 300 行，core 一行不改 |

### 为什么先做 `commit` 和 `weekly`

1. **它们不需要分片、不需要上下文补全** —— 是验证"LLM 链路 + git 采集"最快的路径。`review` 最难（要分片、要上下文、要降误报），先拿简单的把链路跑通，再啃硬的，而不是一上来就死磕最复杂的。
2. **每天都能用上** —— `commit` 一天好几次，`weekly` 一周一次。工具只有高频使用才会被持续打磨；反过来，如果第一个功能是三周才能跑通的 review，很可能跑通之后你就不想维护了。
3. **反馈最快** —— commit message 对不对，一秒钟就知道；周报像不像你写的，一眼就知道。这种即时反馈能在早期快速校准 prompt。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DeepSeek 模型/价格频繁变更 | 成本波动、代码失效 | 模型标识集中配置；按 §5.6 结论，成本本就不是瓶颈 |
| Review 误报/漏报 | 工具被弃用 | 严重度标准写进 rules；支持 `--focus` 限定维度；保留人工确认环节 |
| **`commit` 钩子变成负担** | 每次提交都卡住 | 必须可跳过（`GIT_AGENT_DISABLE=1` / `--no-verify`）；失败时**绝不阻塞提交**，静默退出 0 |
| **命令变多后记不住** | 功能闲置 | `--help` 分组展示 + `git-agent ask` 自然语言入口 |
| 代码外发合规 | 公司项目风险 | 脱敏 + 路径黑名单 + `--dry-run`，见 §5.5 |
| Prompt 迭代难回滚 | 质量波动 | prompt 独立 md 文件，纳入 git 版本管理，可配置指定版本 |
| 大仓库 git 命令慢 | 体验差 | 缓存 merge-base 与采集结果（`.git-agent/cache/`，带 commit 指纹） |
| 反向符号搜索不准 | impact 误报 | `maxDepth` 限 2 层；不确定的一律标 `[待确认]`，不硬编 |
| 未来接 DSH / MCP | API 变更 | 核心逻辑不放薄壳内，只做适配层 |

---

## 11. 待确认事项

1. **代码外发合规**：你日常开发的仓库（如教评产品线）是否允许把 diff 发到外部 API？这决定是否需要做更强的本地脱敏，或改走私有化部署模型。**这是开工前唯一必须先确认的事。**
2. **仓库形态**：单仓库还是 monorepo？monorepo 需要在分片策略上按 package 聚合。
3. **使用范围**：个人工具还是团队共享？团队共享需要考虑 rules 的版本分发与 API Key 管理。
4. **是否需要 CI 集成**：若要在 PR 流水线里自动出报告，需把退出码（§2.3）和 `--json` 输出优先做扎实。
5. **周报输出去向**：本地 Markdown 文件，还是要推送到飞书/钉钉/邮件？这决定 Renderer 层要加哪些实现。
6. **commit 规范**：团队用的是 Conventional Commits 还是自定义？这决定 `commit` 命令的 prompt 与配置项。
