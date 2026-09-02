import { describe, expect, it } from 'vitest';

import { REDACT_RULES } from '../../src/redact/rules.js';

/** 按规则表遍历：正例必须被改写，反例必须原样保留（加规则必须同时加例子） */
describe('REDACT_RULES', () => {
  for (const rule of REDACT_RULES) {
    describe(`规则 ${rule.id}（${rule.name}）`, () => {
      it.each(rule.examples.positive.map((text) => [text]))('改写：%s', (text) => {
        expect(text).toMatch(rule.pattern);
        const masked = text.replace(rule.pattern, rule.replacement);
        expect(masked).not.toBe(text);
        expect(masked).toContain('[REDACTED');
      });

      it.each(rule.examples.negative.map((text) => [text]))('保留：%s', (text) => {
        expect(text.replace(rule.pattern, rule.replacement)).toBe(text);
      });

      it('带 g 标志可连续替换', () => {
        const pos = rule.examples.positive[0];
        if (!pos) return;
        const twice = `${pos} and ${pos}`;
        const masked = twice.replace(rule.pattern, rule.replacement);
        expect((masked.match(/\[REDACTED/g) ?? []).length).toBeGreaterThanOrEqual(2);
      });
    });
  }
});
