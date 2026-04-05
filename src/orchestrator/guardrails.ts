import { eq, and, isNull, or } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { guardrails as guardrailsTable } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'guardrails' });

export interface GuardrailResult {
  passed: boolean;
  action?: 'block' | 'warn' | 'flag' | 'redact';
  ruleName?: string;
  triggerResponse?: string;
  processedText?: string; // After redaction
  triggered: Array<{ name: string; action: string; ruleType: string }>;
}

interface GuardrailRule {
  id: string;
  name: string;
  ruleType: string;
  config: Record<string, unknown>;
  action: string;
  triggerResponse: string | null;
  priority: number | null;
}

/**
 * Run guardrails on text. Scope: 'input' or 'output'.
 * Evaluates global rules first (by priority), then tenant rules.
 */
export async function evaluateGuardrails(
  text: string,
  tenantId: string,
  scope: 'input' | 'output',
): Promise<GuardrailResult> {
  // Load global + tenant guardrails
  const rules = await db
    .select({
      id: guardrailsTable.id,
      name: guardrailsTable.name,
      ruleType: guardrailsTable.ruleType,
      config: guardrailsTable.config,
      action: guardrailsTable.action,
      triggerResponse: guardrailsTable.triggerResponse,
      priority: guardrailsTable.priority,
    })
    .from(guardrailsTable)
    .where(
      and(
        eq(guardrailsTable.isActive, true),
        or(
          isNull(guardrailsTable.tenantId), // global
          eq(guardrailsTable.tenantId, tenantId),
        ),
        or(
          eq(guardrailsTable.appliesTo, scope),
          eq(guardrailsTable.appliesTo, 'both'),
        ),
      ),
    )
    .orderBy(guardrailsTable.priority);

  let processedText = text;
  const triggered: GuardrailResult['triggered'] = [];

  for (const rule of rules) {
    const config = rule.config as Record<string, unknown>;
    const result = evaluateRule(rule.ruleType, config, processedText);

    if (result.matched) {
      triggered.push({ name: rule.name, action: rule.action, ruleType: rule.ruleType });

      log.info({ ruleName: rule.name, action: rule.action, ruleType: rule.ruleType, scope }, 'Guardrail triggered');

      switch (rule.action) {
        case 'block':
          return {
            passed: false,
            action: 'block',
            ruleName: rule.name,
            triggerResponse: rule.triggerResponse ?? "I can't process that request.",
            processedText,
            triggered,
          };

        case 'redact':
          processedText = result.redactedText ?? processedText;
          break;

        case 'warn':
          // Log and continue
          break;

        case 'flag':
          // Will create ticket — handled by caller
          break;
      }
    }
  }

  return {
    passed: true,
    processedText,
    triggered,
  };
}

interface RuleResult {
  matched: boolean;
  redactedText?: string;
}

function evaluateRule(ruleType: string, config: Record<string, unknown>, text: string): RuleResult {
  switch (ruleType) {
    case 'keyword_block':
      return evaluateKeywordBlock(config, text);
    case 'regex_filter':
      return evaluateRegexFilter(config, text);
    case 'topic_restriction':
      return evaluateTopicRestriction(config, text);
    case 'sentiment_filter':
      return evaluateSentimentFilter(config, text);
    case 'pii_detection':
      return evaluatePiiDetection(config, text);
    case 'length_limit':
      return evaluateLengthLimit(config, text);
    default:
      return { matched: false };
  }
}

function evaluateKeywordBlock(config: Record<string, unknown>, text: string): RuleResult {
  const keywords = (config['keywords'] as string[]) ?? [];
  const caseSensitive = config['caseSensitive'] as boolean ?? false;
  const compareText = caseSensitive ? text : text.toLowerCase();

  for (const keyword of keywords) {
    const compareKeyword = caseSensitive ? keyword : keyword.toLowerCase();
    if (compareText.includes(compareKeyword)) {
      // For redaction: replace keyword with [REDACTED]
      const regex = new RegExp(escapeRegex(keyword), caseSensitive ? 'g' : 'gi');
      return { matched: true, redactedText: text.replace(regex, '[REDACTED]') };
    }
  }
  return { matched: false };
}

function evaluateRegexFilter(config: Record<string, unknown>, text: string): RuleResult {
  const pattern = config['pattern'] as string;
  if (!pattern) return { matched: false };

  try {
    const regex = new RegExp(pattern, 'g');
    const matched = regex.test(text);
    if (matched) {
      return { matched: true, redactedText: text.replace(new RegExp(pattern, 'g'), '[REDACTED]') };
    }
  } catch {
    log.warn({ pattern }, 'Invalid regex pattern in guardrail');
  }
  return { matched: false };
}

function evaluateTopicRestriction(config: Record<string, unknown>, _text: string): RuleResult {
  // Topic restriction requires LLM classification — skip in Phase 2 guardrails
  // Will be evaluated during intent classification instead
  return { matched: false };
}

function evaluateSentimentFilter(config: Record<string, unknown>, text: string): RuleResult {
  // Basic heuristic sentiment check (LLM-based sentiment comes from classifier)
  // Check for aggressive language patterns
  const aggressivePatterns = [
    /\b(fuck|shit|damn|hell|idiot|stupid|useless|worst|terrible|horrible|pathetic)\b/i,
    /(!{3,})/, // Multiple exclamation marks
    /[A-Z]{5,}/, // Extended caps
  ];

  for (const pattern of aggressivePatterns) {
    if (pattern.test(text)) {
      return { matched: true };
    }
  }
  return { matched: false };
}

function evaluatePiiDetection(config: Record<string, unknown>, text: string): RuleResult {
  const detectTypes = (config['detect'] as string[]) ?? [];
  let redactedText = text;
  let matched = false;

  const piiPatterns: Record<string, RegExp> = {
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    phone: /\b(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
    credit_card: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    aadhaar: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    pan_card: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  };

  for (const type of detectTypes) {
    const pattern = piiPatterns[type];
    if (pattern && pattern.test(redactedText)) {
      matched = true;
      redactedText = redactedText.replace(new RegExp(pattern.source, pattern.flags), `[${type.toUpperCase()}_REDACTED]`);
    }
  }

  return { matched, redactedText: matched ? redactedText : undefined };
}

function evaluateLengthLimit(config: Record<string, unknown>, text: string): RuleResult {
  const maxChars = (config['max_chars'] as number) ?? 2000;
  return { matched: text.length > maxChars };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
