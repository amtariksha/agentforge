import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/orchestrator/prompt-builder.js';
import type { TenantConfig } from '../../src/shared/types/index.js';

function tenantConfig(): TenantConfig {
  return {
    persona: {
      name: 'Testbot',
      avatar: { name: 'Testbot', emoji: '🤖' },
      personalityTraits: ['helpful'],
      tone: 'balanced',
      definition: 'A test assistant.',
      guidelines: 'Be nice.',
      introduction: 'Hi',
      languagePrimary: 'en',
      languageSupported: ['en'],
      responseStyle: { maxLength: 'short', useEmojis: false, useMarkdown: true, formattingRules: 'none' },
      fallbackMessage: 'Sorry.',
      systemPromptAdditions: '',
    },
  } as unknown as TenantConfig;
}

describe('buildPrompt — Learned Corrections placement', () => {
  it('renders learned corrections in the dynamic block only, never the cached static block', () => {
    const built = buildPrompt({
      tenantConfig: tenantConfig(),
      agentSystemPrompt: 'You are support.',
      toolDefinitions: [],
      conversationHistory: [],
      corrections: ['Always greet by name (#abc123)'],
      pastCorrections: ['When the customer asked: "refund?" — the correct answer is: "We refund within 7 days."'],
    });

    // system[0] is the static, cache_control block; system[1] is the dynamic block.
    const staticBlock = built.system[0];
    const dynamicBlock = built.system[1];

    expect(staticBlock.cache_control).toEqual({ type: 'ephemeral' });
    expect(staticBlock.text).not.toContain('Learned Corrections');
    expect(staticBlock.text).not.toContain('refund within 7 days');

    expect(dynamicBlock).toBeDefined();
    expect(dynamicBlock.cache_control).toBeUndefined();
    expect(dynamicBlock.text).toContain('## Learned Corrections');
    expect(dynamicBlock.text).toContain('refund within 7 days');
    // The rule-based "Active Corrections" block also lives in the dynamic block.
    expect(dynamicBlock.text).toContain('## Active Corrections');
    expect(dynamicBlock.text).toContain('Always greet by name');
  });

  it('omits the learned-corrections block when none are supplied', () => {
    const built = buildPrompt({
      tenantConfig: tenantConfig(),
      agentSystemPrompt: 'You are support.',
      toolDefinitions: [],
      conversationHistory: [],
    });
    const allText = built.system.map((b) => b.text).join('\n');
    expect(allText).not.toContain('Learned Corrections');
  });
});
