# git-agent-toolkit

基于 DeepSeek 的个人 Git 工作流工具箱。从 git 采集数据 → 加工 diff → 组装 prompt → 调 DeepSeek → 渲染成 Markdown 报告落盘。

## 安装

```bash
npm install          # 根目录一次装完两个 workspace
npm run build        # tsc 直出 dist + 拷贝 prompts/*.md
npm run link         # 全局注册 git-agent 命令（npm link -w git-agent-toolkit）
```

配置 API Key（二选一）：

```bash
# 全局（推荐）
echo "DEEPSEEK_API_KEY=sk-xxx" > ~/.git-agent/.env
# 或仓库内 .env
cp .env.example .env
```

## 七个命令

```bash
git-agent commit                       # 暂存区 → 3 个提交信息候选 → 选一个提交
git-agent weekly --note "本周重点是重构"  # 本周 log → 周报
git-agent review --base origin/main    # 代码审查（分片 + 汇总 + 跨文件）
git-agent test-plan --base origin/main # 测试计划（P0/P1/P2）
git-agent impact --base origin/main    # 影响面分析（反向符号搜索）
git-agent pr-desc --base origin/main   # PR 描述（按仓库模板填充）
git-agent spec --base origin/main      # 技术方案反推
git-agent ask "帮我生成本周周报"         # 自然语言挑命令
```

通用参数：`--base` `--head` `--out` `--stdout` `--json` `--dry-run` `--no-cache` `-v` `--quiet`

## 加一个新功能（3 步）

1. 新建 `packages/core/src/features/xxx/index.ts`（实现 `Feature` 接口）+ `schema.ts`
2. 新建 `packages/core/prompts/xxx/*.md`
3. 在 `packages/core/src/features/index.ts` 加一行 `register(xxxFeature)`

CLI 无需任何改动 —— 命令、参数、`--help` 全部从注册表自动生成。

## 开发

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run dev -- commit  # tsx 直接跑 CLI
```

## 约定

- 分支对比一律用三点语法 `git diff <base>...<head>`，禁止两点（两点会把 base 新合入的内容误判成"你的删除"）。
- 只读原则：除 `commit` 命令外，不写 git 状态、不改源码文件。
- 模型 id 只在 `config.llm.model` 两处配置（`deepseek-v4-flash` / `deepseek-v4-pro`）。
- 报告默认落 `<repo>/.git-agent/reports/YYYY-MM/`，终端只打一行摘要。
