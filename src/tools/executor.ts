import { eq, and } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { tools as toolsTable, agentTools, agentTypes } from '../shared/schema/index.js';
import { getHandler } from './tenant-gateway/registry.js';
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

  const mapping = tool.backendMapping as BackendMapping;
  const execConfig = (tool.executionConfig as { timeoutMs?: number; retryCount?: number; fallbackMessage?: string }) ?? {};
  const timeoutMs = execConfig.timeoutMs ?? 5000;

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
      durationMs: Date.now() - startTime,
    }, 'Tool executed');

    return { ...result, durationMs: Date.now() - startTime };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, tool: toolName }, 'Tool execution failed');

    return {
      success: false,
      data: null,
      error: { code: 'EXECUTION_ERROR', message: errorMessage },
      durationMs: Date.now() - startTime,
    };
  }
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

async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  return Promise.race([promise, timeout]);
}
