import type { ToolExecutionResult } from '../../shared/types/index.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'tenant-gateway' });

export interface GatewayContext {
  tenantId: string;
  userId?: string;
  conversationId?: string;
}

export type GatewayHandler = (
  params: Record<string, unknown>,
  ctx: GatewayContext,
) => Promise<ToolExecutionResult>;

const registry = new Map<string, GatewayHandler>();

export function registerHandler(key: string, handler: GatewayHandler) {
  registry.set(key, handler);
  log.debug({ key }, 'Registered gateway handler');
}

export function getHandler(tenantSlug: string, handlerName: string): GatewayHandler | undefined {
  // handler format: "swarg-food.getUserProfile" → key = "swarg-food.getUserProfile"
  const key = `${tenantSlug}.${handlerName}`;
  return registry.get(key) ?? registry.get(handlerName);
}

export function listHandlers(): string[] {
  return Array.from(registry.keys());
}

// Auto-register tenant modules
export async function initializeGateway() {
  try {
    const swargFood = await import('./swarg-food/index.js');
    swargFood.register();
    log.info('Tenant gateway initialized');
  } catch (err) {
    log.error({ err }, 'Failed to initialize tenant gateway');
  }
}
