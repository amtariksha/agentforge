import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantConfig } from '../shared/types/index.js';
import type Anthropic from '@anthropic-ai/sdk';

const PROMPTS_DIR = join(import.meta.dirname, '..', '..', 'config', 'system-prompts');

// Cache system prompt files in memory (they don't change at runtime)
let basePrompt: string | null = null;
let safetyPrompt: string | null = null;
let memoryPrompt: string | null = null;

function loadPromptFile(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), 'utf-8');
}

function getBasePrompt(): string {
  if (!basePrompt) basePrompt = loadPromptFile('base.md');
  return basePrompt;
}

function getSafetyPrompt(): string {
  if (!safetyPrompt) safetyPrompt = loadPromptFile('safety.md');
  return safetyPrompt;
}

function getMemoryPrompt(): string {
  if (!memoryPrompt) memoryPrompt = loadPromptFile('memory-instructions.md');
  return memoryPrompt;
}

interface PromptContext {
  tenantConfig: TenantConfig;
  agentSystemPrompt: string;
  toolDefinitions: Anthropic.Tool[];

  // Dynamic context
  userProfile?: Record<string, unknown>;
  memoryIndex?: string;
  ragContext?: string;
  conversationHistory: Anthropic.MessageParam[];
  language?: string;
  corrections?: string[];
}

interface BuiltPrompt {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export function buildPrompt(ctx: PromptContext): BuiltPrompt {
  const persona = ctx.tenantConfig.persona;

  // === STATIC BLOCK (cacheable) ===
  // This entire block is the same for all sessions of this tenant + agent type combo
  const staticParts: string[] = [
    getBasePrompt(),
    getSafetyPrompt(),
    getMemoryPrompt(),
    '',
    '## Your Identity',
    `You are ${persona.name}.`,
    persona.definition,
    '',
    '## Personality & Tone',
    `Personality: ${persona.personalityTraits.join(', ')}`,
    `Tone: ${persona.tone}`,
    persona.guidelines,
    '',
    '## Response Style',
    `Max length: ${persona.responseStyle.maxLength}`,
    `Use emojis: ${persona.responseStyle.useEmojis ? 'Yes, sparingly' : 'No'}`,
    `Use markdown: ${persona.responseStyle.useMarkdown ? 'Yes' : 'No'}`,
    persona.responseStyle.formattingRules,
    '',
    '## Agent Role',
    ctx.agentSystemPrompt,
  ];

  if (persona.systemPromptAdditions) {
    staticParts.push('', '## Business Context', persona.systemPromptAdditions);
  }

  const staticBlock = staticParts.join('\n');

  // === DYNAMIC BLOCK (changes per session/turn) ===
  const dynamicParts: string[] = [];

  // User profile
  if (ctx.userProfile) {
    dynamicParts.push('## Current Customer');
    dynamicParts.push(JSON.stringify(ctx.userProfile, null, 2));
  }

  // Memory index
  if (ctx.memoryIndex) {
    dynamicParts.push('', '## Memory Index (hints — verify before acting)');
    dynamicParts.push(ctx.memoryIndex);
  }

  // RAG context (knowledge base results)
  if (ctx.ragContext) {
    dynamicParts.push('', '## Relevant Knowledge Base Context');
    dynamicParts.push('Use the following information to answer the customer\'s question if relevant:');
    dynamicParts.push(ctx.ragContext);
  }

  // Active corrections
  if (ctx.corrections && ctx.corrections.length > 0) {
    dynamicParts.push('', '## Active Corrections');
    for (const correction of ctx.corrections) {
      dynamicParts.push(`- ${correction}`);
    }
  }

  // Language instruction
  if (ctx.language && ctx.language !== 'en') {
    dynamicParts.push('', `## Language: Respond in ${ctx.language}. The customer is communicating in this language.`);
  }

  const dynamicBlock = dynamicParts.join('\n');

  // Build system blocks with cache boundary
  // Static block comes first with cache_control for prompt caching
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text' as const,
      text: staticBlock,
      cache_control: { type: 'ephemeral' as const },
    },
  ];

  // Dynamic block after the cache boundary
  if (dynamicBlock.length > 0) {
    systemBlocks.push({
      type: 'text' as const,
      text: dynamicBlock,
    });
  }

  return {
    system: systemBlocks,
    messages: ctx.conversationHistory,
    tools: ctx.toolDefinitions,
  };
}

// Convert tool definitions from DB format to Anthropic tool format
export function toAnthropicTools(toolDefs: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>): Anthropic.Tool[] {
  return toolDefs.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));
}
