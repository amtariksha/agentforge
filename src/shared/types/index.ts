export type { UnifiedMessage } from './unified-message.js';
export type { TenantConfig, AgentTypeConfig } from './tenant-config.js';
export type { ToolDefinition, BackendMapping, ToolExecutionResult } from './tool-definition.js';
export type { ContentBlock, ContentBlockType, MessageContent, Action } from '../../ui/content-blocks.js';

import type { TenantConfig, AgentTypeConfig } from './tenant-config.js';
import type { ToolDefinition } from './tool-definition.js';

export interface IntentClassification {
  intent: string;
  agentType: string;
  complexity: 'simple' | 'medium' | 'complex';
  confidence: number;
  requiresBackendData: boolean;
  requiresHitl: boolean;
  requiresRag: boolean;
  suggestedTools: string[];
  languageDetected: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'angry';
}

export interface ConversationTrace {
  traceId: string;
  conversationId: string;
  turnNumber: number;
  timing: {
    totalMs: number;
    classificationMs?: number;
    llmMs: number;
    toolMs?: number;
    guardrailMs?: number;
  };
  ai: {
    modelUsed: string;
    tokensInput: number;
    tokensOutput: number;
    /** @deprecated kept for legacy trace parsing; equals tokensCacheRead going forward. */
    tokensCached: number;
    tokensCacheWrite: number;
    tokensCacheRead: number;
    confidence?: number;
    intent?: string;
    agentType?: string;
  };
  toolsCalled: { name: string; status: string; durationMs: number }[];
  guardrailsTriggered: { name: string; action: string }[];
  hitlTriggered: boolean;
  wasCorrected: boolean;
}

export interface TenantSeed {
  tenant: {
    name: string;
    slug: string;
    config: TenantConfig;
  };
  agents: AgentTypeConfig[];
  tools: {
    definition: Omit<ToolDefinition, 'id' | 'tenantId'>;
    assignToAgents: string[];
  }[];
  guardrails: {
    name: string;
    ruleType: string;
    config: Record<string, unknown>;
    action: string;
    appliesTo: string;
    priority: number;
    isActive: boolean;
    triggerResponse?: string;
  }[];
  humanAgents: {
    name: string;
    email: string;
    role: 'admin' | 'operator';
    password: string;
  }[];
  webhookConfigs: {
    url: string;
    events: string[];
  }[];
}
