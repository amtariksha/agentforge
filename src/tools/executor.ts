import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../shared/db.js';
import { tools as toolsTable, agentTools, agentTypes } from '../shared/schema/index.js';
import { getHandler } from './tenant-gateway/registry.js';
import { renderUiHandler, RENDER_UI_TOOL_NAME } from './platform/render-ui.js';
import { validateBlocks, filterAllowedBlocks, type ContentBlock } from '../ui/content-blocks.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { ToolExecutionResult, BackendMapping } from '../shared/types/index.js';

const log = createChildLogger({ module: 'tool-executor' });

const MAX_TOOL_ITERATIONS = 10;

interface ToolContext {
  tenantId: string;
  tenantSlug: string;
  userId?: string;
  conversationId?: string;
  agentTypeSlug?: string;
  /**
   * Shadow mode: when true, tools with category 'write' are short-circuited
   * to `{ success: true, data: { dryRun: true } }` without invoking the
   * handler. Read tools still execute normally. Used during the 14-day
   * shadow window for new agents.
   */
  shadowMode?: boolean;
  /**
   * Per-call request id forwarded to admin-panel tool handlers as
   * X-Agent-Force-Request-Id (idempotency key for writes).
   */
  requestId?: string;
  /**
   * Generative-UI block whitelist for the calling agent (agent_types
   * .allowed_block_types). null/undefined = allow all. Applied to any `ui`
   * blocks a tool (or render_ui) returns.
   */
  allowedBlockTypes?: string[] | null;
}

// Load tools for a given agent type
export async function loadToolsForAgent(tenantId: string, agentTypeSlug: string) {
  const [agentType] = await db
    .select({ id: agentTypes.id })
    .from(agentTypes)
    .where(and(eq(agentTypes.tenantId, tenantId), eq(agentTypes.slug, agentTypeSlug)))
    .limit(1);

  if (!agentType) return [];

  const result = await db
    .select({
      id: toolsTable.id,
      name: toolsTable.name,
      description: toolsTable.description,
      category: toolsTable.category,
      requiresHitl: toolsTable.requiresHitl,
      requiresUserConfirm: toolsTable.requiresUserConfirm,
      parameters: toolsTable.parameters,
      backendMapping: toolsTable.backendMapping,
      executionConfig: toolsTable.executionConfig,
    })
    .from(toolsTable)
    .innerJoin(agentTools, eq(agentTools.toolId, toolsTable.id))
    .where(
      and(
        eq(agentTools.agentTypeId, agentType.id),
        eq(toolsTable.tenantId, tenantId),
        eq(toolsTable.isActive, true),
      ),
    );

  return result;
}

// Execute a single tool call
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // Platform tool: render_ui is global (no tenant tool row, no HITL/shadow — it
  // has no side effects). Dispatch directly; ui blocks are sanitized below.
  if (toolName === RENDER_UI_TOOL_NAME) {
    const result = await renderUiHandler(params, {
      tenantId: ctx.tenantId, userId: ctx.userId, conversationId: ctx.conversationId,
    });
    return { ...result, ui: sanitizeUi(result.ui, ctx, toolName), durationMs: Date.now() - startTime };
  }

  // Look up tool definition
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(and(eq(toolsTable.tenantId, ctx.tenantId), eq(toolsTable.name, toolName)))
    .limit(1);

  if (!tool) {
    return {
      success: false,
      data: null,
      error: { code: 'TOOL_NOT_FOUND', message: `Tool "${toolName}" not found` },
      durationMs: Date.now() - startTime,
    };
  }

  // Validate the param envelope before any handler/HTTP call. The model can
  // emit malformed inputs; reject them early rather than let a handler blow up.
  const paramCheck = validateParams(params, tool.parameters);
  if (!paramCheck.ok) {
    return {
      success: false,
      data: null,
      error: { code: 'INVALID_PARAMS', message: paramCheck.message },
      durationMs: Date.now() - startTime,
    };
  }

  // Shadow-mode short-circuit for write-category tools. Agent still sees a
  // successful tool_result so it can produce coherent output, but no side
  // effects land in downstream systems.
  if (ctx.shadowMode && tool.category === 'write') {
    log.info({ tool: toolName, agent: ctx.agentTypeSlug }, 'Shadow mode: write tool short-circuited');
    return {
      success: true,
      data: { dryRun: true, tool: toolName, params },
      error: undefined,
      durationMs: Date.now() - startTime,
    };
  }

  // HITL gate — tools flagged requiresHitl/requiresUserConfirm must not execute
  // inline. Per CLAUDE.md, destructive tools need human approval; the agent
  // surfaces this and the operator drives the approval-queue flow separately.
  if (tool.requiresHitl || tool.requiresUserConfirm) {
    log.info({ tool: toolName, agent: ctx.agentTypeSlug }, 'HITL gate: tool requires approval, not executed inline');
    return {
      success: false,
      data: null,
      error: { code: 'HITL_REQUIRED', message: `Tool "${toolName}" requires human approval before it can run` },
      durationMs: Date.now() - startTime,
    };
  }

  const mapping = tool.backendMapping as BackendMapping;
  const execConfig = (tool.executionConfig as { timeoutMs?: number; retryCount?: number; fallbackMessage?: string }) ?? {};
  const timeoutMs = execConfig.timeoutMs ?? 5000;
  const retryCount = execConfig.retryCount ?? 0;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      let result: ToolExecutionResult;

      if (mapping.type === 'internal') {
        // PATH B: Internal gateway — call handler directly
        const handlerRef = mapping.handler;
        if (!handlerRef) {
          throw new Error(`Internal tool "${toolName}" has no handler defined`);
        }

        // Parse "tenant-slug.handlerName" → look up in registry
        const handler = getHandler(ctx.tenantSlug, handlerRef.split('.').slice(1).join('.'));
        if (!handler) {
          // Try full reference
          const fullHandler = getHandler('', handlerRef);
          if (!fullHandler) {
            throw new Error(`Handler "${handlerRef}" not found in gateway registry`);
          }
          result = await executeWithTimeout(
            fullHandler(params, { tenantId: ctx.tenantId, userId: ctx.userId, conversationId: ctx.conversationId }),
            timeoutMs,
          );
        } else {
          result = await executeWithTimeout(
            handler(params, { tenantId: ctx.tenantId, userId: ctx.userId, conversationId: ctx.conversationId }),
            timeoutMs,
          );
        }
      } else {
        // PATH A: External API — HTTP request
        result = await executeExternalTool(mapping, params, timeoutMs);
      }

      log.info({
        tool: toolName,
        success: result.success,
        attempt,
        durationMs: Date.now() - startTime,
      }, 'Tool executed');

      return { ...result, ui: sanitizeUi(result.ui, ctx, toolName), durationMs: Date.now() - startTime };
    } catch (err) {
      lastError = err;
      log.warn({ err, tool: toolName, attempt, retryCount }, 'Tool execution attempt failed');
    }
  }

  // All attempts exhausted — use the configured fallbackMessage if present.
  const errorMessage = execConfig.fallbackMessage
    ?? (lastError instanceof Error ? lastError.message : 'Unknown error');
  log.error({ err: lastError, tool: toolName, attempts: retryCount + 1 }, 'Tool execution failed');

  return {
    success: false,
    data: null,
    error: { code: 'EXECUTION_ERROR', message: errorMessage },
    durationMs: Date.now() - startTime,
  };
}

/**
 * Lightweight param gate: the input must be an object, and every key listed in
 * the tool's JSON-schema `required` array must be present. Full schema
 * validation is left to the model's `strict` tool use; this catches gross
 * malformation before a handler runs.
 */
function validateParams(
  params: unknown,
  parameters: unknown,
): { ok: true } | { ok: false; message: string } {
  const envelope = z.record(z.string(), z.unknown()).safeParse(params);
  if (!envelope.success) {
    return { ok: false, message: 'Tool parameters must be an object' };
  }
  const required = (parameters as { required?: unknown } | null)?.required;
  if (Array.isArray(required)) {
    const missing = required.filter(
      (k): k is string => typeof k === 'string' && envelope.data[k] === undefined,
    );
    if (missing.length > 0) {
      return { ok: false, message: `Missing required parameters: ${missing.join(', ')}` };
    }
  }
  return { ok: true };
}

async function executeExternalTool(
  mapping: BackendMapping,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolExecutionResult> {
  if (!mapping.endpoint || !mapping.method) {
    throw new Error('External tool missing endpoint or method');
  }

  // Replace path params: "/orders/{order_id}" → "/orders/123"
  let url = mapping.endpoint;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...mapping.headers,
  };

  const fetchOptions: RequestInit = {
    method: mapping.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (['POST', 'PUT', 'PATCH'].includes(mapping.method)) {
    const body = mapping.bodyTemplate
      ? { ...mapping.bodyTemplate, ...params }
      : params;
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json();

  const rm = mapping.responseMapping;
  if (rm) {
    const success = getNestedValue(data, rm.successField);
    const resultData = getNestedValue(data, rm.dataField);
    const error = getNestedValue(data, rm.errorField);

    return {
      success: Boolean(success),
      data: resultData,
      error: error ? { code: 'API_ERROR', message: String(error) } : undefined,
      durationMs: 0,
    };
  }

  return {
    success: response.ok,
    data,
    error: response.ok ? undefined : { code: `HTTP_${response.status}`, message: response.statusText },
    durationMs: 0,
  };
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Validate + whitelist a tool's raw `ui` blocks (paths A and B). Malformed
 * blocks are dropped (logged), disallowed types filtered by the agent's
 * allowedBlockTypes. Returns undefined when nothing survives so callers can
 * treat "no ui" uniformly. The `data` payload is never touched — a bad ui
 * array must not lose the tool's factual result.
 */
function sanitizeUi(
  rawUi: unknown,
  ctx: ToolContext,
  toolName: string,
): ContentBlock[] | undefined {
  if (rawUi === undefined || rawUi === null) return undefined;
  const { blocks, errors } = validateBlocks(rawUi);
  if (errors.length > 0) {
    log.warn({ tool: toolName, dropped: errors.length }, 'Dropped invalid ui blocks from tool result');
  }
  const allowed = filterAllowedBlocks(blocks, ctx.allowedBlockTypes);
  return allowed.length > 0 ? allowed : undefined;
}

async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
