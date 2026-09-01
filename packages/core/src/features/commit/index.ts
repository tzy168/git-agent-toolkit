import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import { blockDiff, blockStats } from '../shared/prompt-blocks.js';
import { collectStaged } from '../shared/collect-staged.js';
import type { Feature, PromptStep } from '../registry.js';
import { CommitOutputSchema, formatCommitMessage, type CommitOutput } from './schema.js';

export interface CommitInput {
  prefill?: boolean;
}

let systemTpl = '';
let draftTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('commit/system');
  draftTpl = await loadPrompt('commit/draft');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

export const commitFeature: Feature<CommitInput, CommitOutput> = {
  id: 'commit',
  name: '提交信息',
  description: '根据暂存区生成 Conventional Commit 候选并提交',
  params: [
    { flag: '--prefill', description: '钩子模式：把首选信息写到 --out，不交互、不真正 commit', type: 'boolean' },
    { flag: '--lang <code>', description: '提交说明语言（默认 zh-CN）', type: 'string' },
  ],
  outputSchema: CommitOutputSchema,

  async collect(ctx) {
    await loadTemplates();
    return collectStaged(ctx);
  },

  buildSteps(data, ctx): PromptStep[] {
    const cfg = ctx.config.commit;
    const vars = {
      types: cfg.types.join(', '),
      convention: cfg.convention,
      maxSubjectLength: String(cfg.maxSubjectLength),
      candidates: String(cfg.candidates),
      language: languageLabel(cfg.language),
    };
    return [
      {
        kind: 'single',
        id: 'draft',
        label: '生成提交信息',
        system: applyVars(`${systemTpl}\n\n${sharedRules}`, vars),
        schema: CommitOutputSchema,
        model: 'fast',
        thinking: 'off',
        buildUser() {
          const subjects = (data.extra.recentSubjects as string[] | undefined) ?? [];
          return applyVars(draftTpl, {
            ...vars,
            diff: blockDiff(data),
            stats: blockStats(data),
            recentSubjects: subjects.map((s) => `- ${s}`).join('\n') || '（无）',
          });
        },
      },
    ];
  },

  render(output) {
    const lines = output.candidates.map((c, i) => `【${i + 1}】\n${formatCommitMessage(c)}`);
    if (output.splitHint) lines.push(`\n拆分建议：${output.splitHint}`);
    return lines.join('\n\n');
  },
};

/** zh-CN / en 等写成模型读得懂的语言名 */
function languageLabel(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === 'zh' || c === 'zh-cn' || c === 'zh-hans' || c === 'cn' || c === '中文') return '简体中文';
  if (c === 'zh-tw' || c === 'zh-hant') return '繁体中文';
  if (c === 'en' || c === 'en-us' || c === 'en-gb') return 'English';
  return code;
}
