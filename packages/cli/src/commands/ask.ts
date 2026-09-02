import type { Command } from 'commander';

import { listFeatures } from '@git-agent/core';

import { buildContext } from '../context.js';
import { EXIT } from '../exit.js';
import { confirm } from '../interactive.js';

interface AskDecision {
  command: string;
  flags: Record<string, string>;
  reason: string;
}

const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '要执行的命令名' },
    flags: { type: 'object', description: '命令参数，key 为 --flag 形式，value 为字符串' },
    reason: { type: 'string', description: '选择理由（一句话）' },
  },
  required: ['command', 'flags', 'reason'],
  additionalProperties: false,
} as const;

/** git-agent ask "<需求>"：模型挑命令 + 参数，展示并确认后执行 */
export async function askCommand(query: string, program: Command): Promise<number> {
  const ctx = await buildContext({});

  const menu = listFeatures()
    .map((f) => `- ${f.id}：${f.description}`)
    .join('\n');
  const system = [
    '你是 git-agent 的命令路由器。根据用户需求从下列命令中挑一个，并给出参数。',
    '可用命令：',
    menu,
    '',
    '要求：',
    '- 只输出一个 JSON 对象：{"command":"...","flags":{"--flag":"value"},"reason":"..."}',
    '- flags 只含该命令支持的参数，没有就给空对象；不编造命令或参数',
    '- 拿不准就选最接近的，并在 reason 里说明',
  ].join('\n');

  const res = await ctx.llm.complete({
    system,
    user: query,
    tier: 'fast',
    thinking: 'off',
    jsonSchema: DECISION_JSON_SCHEMA,
    meta: { featureId: 'ask', stepId: 'route' },
  });

  const decision = parseDecision(res.text);
  const sub = program.commands.find((c) => c.name() === decision.command);
  if (!sub) {
    ctx.logger.error(`模型挑了不存在的命令：${decision.command}`);
    return EXIT.ERR;
  }

  const argv = flagsToArgv(decision.flags);
  const printable = `gat ${decision.command}${argv.length > 0 ? ` ${argv.join(' ')}` : ''}`;
  console.error(`模型建议（${decision.reason}）`);
  console.error(`  ${printable}`);
  if (!(await confirm('确认执行以上命令？'))) {
    console.error('已取消');
    return EXIT.NO_DATA;
  }

  await sub.parseAsync(argv, { from: 'user' });
  const code = process.exitCode;
  return typeof code === 'number' ? code : EXIT.OK;
}

/** 从模型输出中提取第一个 JSON 对象；非法输出返回安全空决策 */
function parseDecision(text: string): AskDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const raw = JSON.parse(text.slice(start, end + 1)) as Partial<AskDecision>;
      if (typeof raw.command === 'string' && raw.command.trim() !== '') {
        return {
          command: raw.command.trim(),
          flags: typeof raw.flags === 'object' && raw.flags !== null ? (raw.flags as Record<string, string>) : {},
          reason: typeof raw.reason === 'string' ? raw.reason : '未说明',
        };
      }
    } catch {
      // 落到下面的兜底
    }
  }
  return { command: '', flags: {}, reason: '模型输出无法解析' };
}

/** {"--since":"x"} → ['--since','x']；值为 true 的布尔开关只放 flag 本身 */
function flagsToArgv(flags: Record<string, string>): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    const flag = key.startsWith('--') ? key : `--${key}`;
    if (value === 'true' || value === '' || value == null) argv.push(flag);
    else argv.push(flag, String(value));
  }
  return argv;
}
