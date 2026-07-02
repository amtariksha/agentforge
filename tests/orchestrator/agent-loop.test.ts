import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';
import { makeCard, makeTable } from '../helpers/block-factories.js';
import type { UnifiedMessage, TenantConfig } from '../../src/shared/types/index.js';

const h = vi.hoisted(() => ({
  holder: { db: null as unknown },
  buildPromptMock: vi.fn(),
  toAnthropicToolsMock: vi.fn(() => []),
  callLlmMock: vi.fn(),
  sendWhatsAppMock: vi.fn(async () => {}),
  computeCostMock: vi.fn(async () => ({ costUsd: 0.02, pricingId: 'p1' })),
  incrementBudgetMock: vi.fn(async () => {}),
  checkBudgetMock: vi.fn(async () => ({ withinBudget: true, used: 0, limit: 1000, percentUsed: 0 })),
  searchPastMock: vi.fn(async () => [{ userText: 'refund?', originalText: null, correctedText: '7 days', score: 0.9 }]),
  formatPastMock: vi.fn(() => ['learned: refund 7 days']),
  executeToolMock: vi.fn(async (): Promise<{ success: boolean; data: unknown; ui?: unknown; durationMs: number }> => ({ success: true, data: { ok: 1 }, durationMs: 1 })),
  guardrailMock: vi.fn(async (text: string) => ({ passed: true, processedText: text, triggered: [] as unknown[] })),
}));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(h.holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/orchestrator/prompt-builder.js', () => ({ buildPrompt: h.buildPromptMock, toAnthropicTools: h.toAnthropicToolsMock }));
vi.mock('../../src/orchestrator/llm-provider.js', () => ({ callLlm: h.callLlmMock }));
vi.mock('../../src/orchestrator/pricing.js', () => ({ computeCostUsd: h.computeCostMock }));
vi.mock('../../src/orchestrator/budget.js', () => ({ checkBudget: h.checkBudgetMock, incrementBudgetUsage: h.incrementBudgetMock }));
vi.mock('../../src/orchestrator/classifier.js', () => ({ classifyIntent: vi.fn(), selectModel: vi.fn(() => 'claude-sonnet-4-6') }));
vi.mock('../../src/orchestrator/guardrails.js', () => ({ evaluateGuardrails: h.guardrailMock }));
vi.mock('../../src/orchestrator/compaction.js', () => ({ compactIfNeeded: vi.fn(async () => ({ messages: [] })) }));
vi.mock('../../src/orchestrator/language.js', () => ({ detectLanguage: vi.fn(() => 'en') }));
vi.mock('../../src/memory/memory-manager.js', () => ({ getMemoryIndex: vi.fn(async () => null) }));
vi.mock('../../src/memory/knowledge-base.js', () => ({ searchKnowledge: vi.fn(async () => []) }));
vi.mock('../../src/tools/executor.js', () => ({ loadToolsForAgent: vi.fn(async () => []), executeTool: h.executeToolMock }));
vi.mock('../../src/gateway/whatsapp/sender.js', () => ({ sendWhatsAppText: h.sendWhatsAppMock }));
vi.mock('../../src/gateway/telegram/webhook.js', () => ({ sendTelegramText: vi.fn(async () => {}) }));
vi.mock('../../src/gateway/whatsapp/coexistence.js', () => ({ isAgentPaused: vi.fn(async () => false) }));
vi.mock('../../src/gateway/outbound-webhooks.js', () => ({ fireWebhooks: vi.fn(async () => {}) }));
vi.mock('../../src/admin/hitl/escalation.js', () => ({ evaluateEscalation: vi.fn(() => ({ shouldEscalate: false, reasons: [], priority: 'low' })), executeEscalation: vi.fn(async () => {}) }));
vi.mock('../../src/admin/corrections/routes.js', () => ({ loadActiveCorrections: vi.fn(async () => []) }));
vi.mock('../../src/admin/corrections/retrieval.js', () => ({ searchPastCorrections: h.searchPastMock, formatPastCorrections: h.formatPastMock }));

import { processMessage } from '../../src/orchestrator/agent-loop.js';

let mock: MockDb;

function message(): UnifiedMessage {
  return {
    channel: 'whatsapp',
    content: { type: 'text', text: 'hi' },
    sender: { platformUserId: 'ph1', displayName: 'X' },
    metadata: {},
  } as unknown as UnifiedMessage;
}

function config(): TenantConfig {
  return {
    orchestrator: { enableAutoRouting: false },
    ai: { primaryModel: 'claude-sonnet-4-6', maxTokensPerResponse: 512, temperature: 0.7, monthlyTokenBudget: 1_000_000 },
    context: { maxConversationTurns: 50, systemTokenBudget: 2000 },
    persona: { fallbackMessage: 'Sorry, escalating.' },
    channels: {},
  } as unknown as TenantConfig;
}

function llmText(model: string, text = 'hello') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 20, cache_write_tokens: 5, cache_read_tokens: 10 },
    servedBy: { provider: 'anthropic', model },
    stopReason: 'end_turn',
  };
}

/** Queue the standard select/returning sequence up to the LLM call. */
function queueThroughSetup(agent: Record<string, unknown>) {
  mock.queueSelect('users', []);
  mock.queueReturning([{ id: 'u1', profileData: null, languagePreferred: null }]);
  mock.queueSelect('conversations', []);
  mock.queueReturning([{ id: 'c1', messageCount: 0 }]);
  mock.queueSelect('agent_types', [agent]);
  mock.queueSelect('messages', []); // history
}

const agent = { id: 'a1', slug: 'support', isDefault: true, isActive: true, systemPrompt: 'You are support.', modelOverride: null };

beforeEach(() => {
  mock = createMockDb();
  h.holder.db = mock.db;
  vi.clearAllMocks();
  h.buildPromptMock.mockReturnValue({ system: [{ type: 'text', text: 'sys' }], messages: [], tools: [] });
  h.toAnthropicToolsMock.mockReturnValue([]);
  h.checkBudgetMock.mockResolvedValue({ withinBudget: true, used: 0, limit: 1000, percentUsed: 0 });
  h.guardrailMock.mockImplementation(async (text: string) => ({ passed: true, processedText: text, triggered: [] }));
  h.searchPastMock.mockResolvedValue([{ userText: 'refund?', originalText: null, correctedText: '7 days', score: 0.9 }]);
  h.formatPastMock.mockReturnValue(['learned: refund 7 days']);
  h.computeCostMock.mockResolvedValue({ costUsd: 0.02, pricingId: 'p1' });
});

describe('processMessage — happy path', () => {
  it('injects retrieved corrections, logs split-token usage with servedBy, and replies', async () => {
    queueThroughSetup(agent);
    h.callLlmMock.mockResolvedValue(llmText('claude-sonnet-4-6'));

    await processMessage(message(), 't1', config());

    // Retrieved corrections reach the prompt builder.
    expect(h.buildPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ pastCorrections: ['learned: refund 7 days'] }),
    );
    // Reply delivered.
    expect(h.sendWhatsAppMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: 'hello' }));
    // Budget counter incremented by input+output.
    expect(h.incrementBudgetMock).toHaveBeenCalledWith('t1', 120);

    // Exactly one usage row, carrying the served provider/model + split cache columns.
    const usageInserts = mock.inserts.filter((i) => i.table === 'llm_usage_logs');
    expect(usageInserts).toHaveLength(1);
    expect(usageInserts[0].values).toMatchObject({
      provider: 'anthropic', model: 'claude-sonnet-4-6',
      tokensCacheWrite: 5, tokensCacheRead: 10, pricingId: 'p1',
    });
    // A trace row is written.
    expect(mock.inserts.some((i) => i.table === 'conversation_traces')).toBe(true);
  });

  it('attributes the usage row to the fallback model when the provider fell back', async () => {
    queueThroughSetup(agent);
    h.callLlmMock.mockResolvedValue(llmText('claude-haiku-4-5'));

    await processMessage(message(), 't1', config());

    const usage = mock.inserts.find((i) => i.table === 'llm_usage_logs');
    expect(usage?.values).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });
});

describe('processMessage — tool-use loop', () => {
  it('executes the tool with tenant context and logs a single summed usage row', async () => {
    mock.queueSelect('users', []);
    mock.queueReturning([{ id: 'u1', profileData: null, languagePreferred: null }]);
    mock.queueSelect('conversations', []);
    mock.queueReturning([{ id: 'c1', messageCount: 0 }]);
    mock.queueSelect('agent_types', [agent]);
    mock.queueSelect('messages', []);
    mock.queueSelect('tenants', [{ slug: 'swarg' }]); // tenant-slug lookup inside the tool loop

    h.callLlmMock
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu1', name: 'get_orders', input: {} }],
        usage: { input_tokens: 100, output_tokens: 20, cache_write_tokens: 5, cache_read_tokens: 10 },
        servedBy: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        stopReason: 'tool_use',
      })
      .mockResolvedValueOnce(llmText('claude-sonnet-4-6', 'done'));

    await processMessage(message(), 't1', config());

    expect(h.executeToolMock).toHaveBeenCalledWith(
      'get_orders', {}, expect.objectContaining({ tenantId: 't1', agentTypeSlug: 'support' }),
    );
    // Two LLM turns → tokens summed once into a single usage row.
    const usage = mock.inserts.filter((i) => i.table === 'llm_usage_logs');
    expect(usage).toHaveLength(1);
    expect(usage[0].values).toMatchObject({ tokensInput: 200, tokensOutput: 40 });
    expect(h.computeCostMock).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6', expect.objectContaining({ input: 200, output: 40 }));
  });
});

describe('processMessage — guards and failures', () => {
  it('does not call the LLM or write usage when the tenant budget is exceeded', async () => {
    mock.queueSelect('users', []);
    mock.queueReturning([{ id: 'u1', profileData: null, languagePreferred: null }]);
    mock.queueSelect('conversations', []);
    mock.queueReturning([{ id: 'c1', messageCount: 0 }]);
    h.checkBudgetMock.mockResolvedValue({ withinBudget: false, used: 2000, limit: 1000, percentUsed: 200 });

    await processMessage(message(), 't1', config());

    expect(h.callLlmMock).not.toHaveBeenCalled();
    expect(h.sendWhatsAppMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: expect.stringContaining('temporarily unavailable') }));
    expect(mock.inserts.some((i) => i.table === 'llm_usage_logs')).toBe(false);
  });

  it('sends the persona fallback and writes no usage row when the LLM call fails terminally', async () => {
    queueThroughSetup(agent);
    h.callLlmMock.mockRejectedValue(new Error('both providers down'));

    await processMessage(message(), 't1', config());

    expect(h.sendWhatsAppMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: 'Sorry, escalating.' }));
    expect(mock.inserts.some((i) => i.table === 'llm_usage_logs')).toBe(false);
  });
});

describe('processMessage — generative UI (M2)', () => {
  const toolTurn = {
    content: [{ type: 'tool_use', id: 'tu1', name: 'get_ui', input: {} }],
    usage: { input_tokens: 100, output_tokens: 20, cache_write_tokens: 5, cache_read_tokens: 10 },
    servedBy: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    stopReason: 'tool_use',
  };

  function webMessage(): UnifiedMessage {
    return {
      channel: 'web',
      content: { type: 'text', text: 'show me' },
      sender: { platformUserId: 'web1' },
      metadata: {},
    } as unknown as UnifiedMessage;
  }

  it('web: tool ui blocks reach the sink and are persisted on the message', async () => {
    mock.queueSelect('users', []);
    mock.queueReturning([{ id: 'u1', profileData: null, languagePreferred: null }]);
    mock.queueSelect('conversations', []);
    mock.queueReturning([{ id: 'c1', messageCount: 0 }]);
    mock.queueSelect('agent_types', [agent]);
    mock.queueSelect('messages', []);
    mock.queueSelect('tenants', [{ slug: 'swarg' }]);
    h.executeToolMock.mockResolvedValue({ success: true, data: { ok: 1 }, ui: [makeCard()], durationMs: 1 });
    h.callLlmMock.mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(llmText('claude-sonnet-4-6', 'here it is'));

    const sink = vi.fn();
    await processMessage(webMessage(), 't1', config(), sink);

    const uiCall = sink.mock.calls.find((c) => (c[0] as { type: string }).type === 'ui');
    expect(uiCall).toBeDefined();
    const blocks = (uiCall![0] as { blocks: Array<{ type: string }> }).blocks;
    expect(blocks.some((b) => b.type === 'product_card')).toBe(true);

    const agentMsg = mock.inserts.filter((i) => i.table === 'messages')
      .find((i) => (i.values as { senderType?: string }).senderType === 'agent');
    const content = (agentMsg!.values as { content: { blocks: Array<{ type: string }> } }).content;
    expect(content.blocks.some((b) => b.type === 'product_card')).toBe(true);
  });

  it('whatsapp: an unsupported block degrades to its fallbackText via the sender', async () => {
    queueThroughSetup(agent);
    mock.queueSelect('tenants', [{ slug: 'swarg' }]);
    h.executeToolMock.mockResolvedValue({ success: true, data: {}, ui: [makeTable()], durationMs: 1 });
    h.callLlmMock.mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(llmText('claude-sonnet-4-6', 'here'));

    await processMessage(message(), 't1', config());

    // The table block has no WhatsApp-native form → sent as its fallbackText.
    expect(h.sendWhatsAppMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: 'A: 1' }));
  });
});
