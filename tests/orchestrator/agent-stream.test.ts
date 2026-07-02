import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/mock-db.js';

const { holder, streamMock, executeToolMock } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  streamMock: vi.fn(),
  executeToolMock: vi.fn(),
}));

vi.mock('../../src/shared/db.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
  pool: { end: () => Promise.resolve() },
}));
vi.mock('../../src/orchestrator/llm-provider.js', () => ({ streamLlm: streamMock, activeProvider: () => 'anthropic' }));
vi.mock('../../src/tools/executor.js', () => ({ loadToolsForAgent: vi.fn(async () => []), executeTool: executeToolMock }));
vi.mock('../../src/orchestrator/pricing.js', () => ({ computeCostUsd: vi.fn(async () => ({ costUsd: 0.01, pricingId: 'p1' })) }));
vi.mock('../../src/gateway/outbound-webhooks.js', () => ({ fireWebhooks: vi.fn(async () => {}) }));

import { streamAgentBySlug } from '../../src/orchestrator/agent-stream.js';

let mock: MockDb;

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1', tenantId: 't1', slug: 'support', name: 'Support', systemPrompt: 'You are support.',
    modelOverride: null, isActive: true, shadowMode: false, dailySpendCapUsd: null, ...overrides,
  };
}

beforeEach(() => {
  mock = createMockDb();
  holder.db = mock.db;
  streamMock.mockReset();
  executeToolMock.mockReset();
});

function run(events: unknown[] = []) {
  return streamAgentBySlug({
    tenantId: 't1', agentSlug: 'support', sessionId: 's1', userMessage: 'hi',
    onEvent: (e) => events.push(e),
  });
}

describe('streamAgentBySlug gates', () => {
  it('returns not_found when the agent does not exist and never calls the LLM', async () => {
    mock.queueSelect('agent_types', []);
    const events: unknown[] = [];
    const res = await run(events);
    expect(res.agentDisabled).toBe('not_found');
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('returns inactive for a disabled agent', async () => {
    mock.queueSelect('agent_types', [agentRow({ isActive: false })]);
    const res = await run();
    expect(res.agentDisabled).toBe('inactive');
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('disables the agent when the daily spend cap is reached, with no LLM call or usage row', async () => {
    mock.queueSelect('agent_types', [agentRow({ dailySpendCapUsd: '50' })]);
    mock.queueSelect('llm_usage_logs', [{ total: 100 }]); // today's spend >= cap
    const events: Array<{ type: string; message?: string }> = [];
    const res = await run(events as unknown[]);

    expect(res.agentDisabled).toBe('budget');
    expect(events).toContainEqual({ type: 'error', message: 'agent_disabled_budget' });
    expect(streamMock).not.toHaveBeenCalled();
    expect(mock.inserts.some((i) => i.table === 'llm_usage_logs')).toBe(false);
  });
});

describe('streamAgentBySlug generative UI', () => {
  function usage() { return { input_tokens: 10, output_tokens: 2, cache_write_tokens: 0, cache_read_tokens: 0 }; }

  it('emits a ui event when a tool returns blocks and persists them', async () => {
    mock.queueSelect('agent_types', [agentRow()]);        // cap null → no cap select
    mock.queueSelect('tenants', [{ slug: 'swarg' }]);
    mock.queueSelect('users', []);
    mock.queueReturning([{ id: 'u1' }]);
    mock.queueSelect('conversations', []);
    mock.queueReturning([{ id: 'c1', messageCount: 0 }]);

    executeToolMock.mockResolvedValue({
      success: true, data: { ok: 1 },
      ui: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }], fallbackText: 'A: 1' }],
      durationMs: 1,
    });
    streamMock
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'get_ui', input: {} }], usage: usage(), servedBy: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }], usage: usage(), servedBy: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, stopReason: 'end_turn' });

    const events: Array<{ type: string; blocks?: Array<{ type: string }> }> = [];
    await run(events as unknown[]);

    const uiEvent = events.find((e) => e.type === 'ui');
    expect(uiEvent).toBeDefined();
    expect(uiEvent!.blocks?.[0].type).toBe('table');

    const agentMsg = mock.inserts.filter((i) => i.table === 'messages')
      .find((i) => (i.values as { senderType?: string }).senderType === 'agent');
    const content = (agentMsg!.values as { content: { blocks: Array<{ type: string }> } }).content;
    expect(content.blocks.some((b) => b.type === 'table')).toBe(true);
  });
});
