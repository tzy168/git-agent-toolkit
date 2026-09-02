# git-agent-toolkit

**English** | [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/tzy168/git-agent-toolkit/pulls)
[![GitHub stars](https://img.shields.io/github/stars/tzy168/git-agent-toolkit?style=social)](https://github.com/tzy168/git-agent-toolkit/stargazers)

> DeepSeek-powered Git workflow CLI. Collect git → process diffs → compose prompts → call DeepSeek → write Markdown reports.

Generate commit messages from the staging area. From a branch comparison, produce a review, test plan, impact analysis, PR description, and technical spec. Local CLI, reports written to disk. Counts come from git facts — the model does not add up files, lines, or commits.

**If this tool helps you, please [Star](https://github.com/tzy168/git-agent-toolkit) the repo. To make it better, [open an Issue](https://github.com/tzy168/git-agent-toolkit/issues) or [send a PR](https://github.com/tzy168/git-agent-toolkit/pulls).**

## What it does

| Command | Purpose |
|---|---|
| `gat commit` | Staging area → 3 commit-message candidates → pick one and commit |
| `gat weekly` | This week's log → weekly report |
| `gat review` | Code review (shard + summarize + cross-file) |
| `gat test-plan` | Test plan (P0 / P1 / P2) |
| `gat impact` | Impact analysis (reverse symbol search) |
| `gat pr-desc` | PR description (filled from the repo template) |
| `gat spec` | Infer a technical spec from the diff |
| `gat ask` | Pick a command from natural language |

Branch comparison always uses three-dot diff: `git diff <base>...<head>`. Except `commit` (and hooks writing `.git/hooks`), the tool is read-only and does not modify source in the analyzed repo.

## Quick start

Requires **Node ≥ 22** and a [DeepSeek API Key](https://platform.deepseek.com/).

```bash
git clone https://github.com/tzy168/git-agent-toolkit.git
cd git-agent-toolkit
npm install
npm run build
npm run link          # register the global gat command (git-agent still works)
```

Set the API key (either one):

```bash
# global (recommended)
mkdir -p ~/.git-agent
echo "DEEPSEEK_API_KEY=sk-xxx" > ~/.git-agent/.env

# or in the repo
cp .env.example .env   # fill in the real key
```

Then, in any git repo:

```bash
gat commit
gat review --base origin/main
gat ask "help me write this week's report"
```

Reports default to `<repo>/.git-agent/reports/YYYY-MM/`. The terminal prints a one-line summary. `--stdout` prints the full report, `--json` prints a structured object, `--dry-run` prints the prompt and does not call the API.

## Command examples

```bash
gat commit                       # staging area → 3 commit-message candidates → pick one
gat weekly --note "this week was a refactor"
gat review --base origin/main
gat test-plan --base origin/main
gat impact --base origin/main
gat pr-desc --base origin/main
gat spec --base origin/main
gat ask "help me write this week's report"
```

Global flags: `--base` `--head` `--out` `--stdout` `--json` `--dry-run` `--cache` `--no-cache` `-v` `--quiet`

Cache is off by default. Enable it with `--cache` or `cache.enabled: true` in config.

Helpers: `gat config init`, `gat hooks install`, `gat cache stats`.

## Add a feature (3 steps)

No CLI changes. Commands, flags, and `--help` are generated from the registry.

1. Add `packages/core/src/features/<id>/index.ts` (implement `Feature`) + `schema.ts`
2. Add `packages/core/prompts/<id>/*.md`
3. Add one `register(...)` line in `packages/core/src/features/index.ts`

Good first contributions: tweak a prompt, add a unit test, fix docs, or ship a small Feature.

## Architecture

```
packages/cli     thin shell: argv, prompts, exit codes
packages/core    all business logic: git / diff / prompt / LLM / Feature
```

```
cli → Feature.collect → pipeline(buildSteps → LLM → zod → reduce) → render → write file
```

- `@git-agent/core` must not import vscode / DOM / any UI API
- A Feature only declares steps; it does not call the LLM. `pipeline.ts` is the only orchestrator
- Interfaces and algorithms: [`docs/architecture.md`](docs/architecture.md)

## Development

```bash
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run dev -- commit  # run the CLI via tsx
```

Package manager is **npm** (workspaces). TypeScript ESM + `module: NodeNext`; relative imports must use a `.js` suffix. Build is `tsc` to `dist`, no bundler.

Handbook for coding agents: [`AGENTS.md`](AGENTS.md). Task order: [`docs/tasks.md`](docs/tasks.md).

## Contributing

Anyone can contribute. You do not need to be a Git or LLM expert first.

**Good places to start:**

- Pure-function tests in `packages/core/test/` (parser, splitter, config loader, budget, …)
- Improve `packages/core/prompts/**/*.md` (changing a prompt changes behavior — say so in the PR)
- Fix stale or unclear sentences in the README or architecture docs
- Add a small Feature (the 3 steps above)
- Report a bug: include the command, a `--dry-run` snippet (redact the key), and the Node version

**Before opening a PR:**

```bash
npm run typecheck
npm test
```

Conventions:

- Branch diffs use three-dot syntax `git diff <base>...<head>`. Two-dot is forbidden
- Read-only: except `commit`, do not write git state or source in the analyzed repo
- `process.exit` is allowed only in the CLI `main()`; core throws `GitAgentError`
- Logs go to stderr only; stdout is for the full report / JSON / `--dry-run`
- Model ids appear only as `MODEL_FAST` / `MODEL_STRONG` in `config/defaults.ts`

Not sure where to start? Open an Issue describing what you want to do — we can label it `good first issue`.

## Star

If `gat commit` or `gat review` saved you a round of work, click Star. That is the most direct support for this repo, and it helps other people find it.

[⭐ Star git-agent-toolkit](https://github.com/tzy168/git-agent-toolkit)

## Usage notes

- Reports default to `<repo>/.git-agent/reports/YYYY-MM/`; the terminal prints a one-line summary
- File counts / added-deleted lines / commit counts in reports come from `data.stats`, not the model
- The provider can be constructed without an API key; the first LLM call raises `NO_API_KEY`

## License

[MIT](LICENSE)
