/**
 * LMS tool handlers for swarg-food tenant.
 *
 * Twelve thin proxies that call the matching swarg-admin-nextjs
 * /api/agent-tools/lms/* route via callAdminApi. Each handler:
 *   • Validates input with Zod (defence in depth — agent loop already
 *     enforces tool input_schema, but tools can be invoked from other
 *     surfaces too).
 *   • Forwards a per-call requestId (idempotency key for writes).
 *   • Returns ToolExecutionResult.
 *
 * Tool slugs follow the integration plan §6.1 naming. The first segment
 * `lms.` is dropped in the registry key (we register under
 * "swarg-food.<short-name>") so the tool's backendMapping in the DB
 * seed uses `{ type: 'internal', handler: 'swarg-food.read_consent_state' }`.
 */
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { registerHandler, type GatewayHandler } from '../registry.js';
import { callAdminApi, AdminApiError } from '../shared/admin-api-client.js';
import { createChildLogger } from '../../../shared/utils/logger.js';
import type { ToolExecutionResult } from '../../../shared/types/index.js';

const log = createChildLogger({ module: 'lms-tools' });

// ─── Zod schemas (used at runtime for validation; mirror these in the seed
//     `tools.parameters` column as JSON Schema). ────────────────────────────

const customerId = z.string().uuid();
const days = z.number().int().min(1).max(365).optional();
const limit = z.number().int().min(1).max(200).optional();

const ReadConsentSchema = z.object({ customerId });
const ReadRfmSchema = z.object({ customerId });
const ReadHealthSchema = z.object({ customerId });
const ReadCampaignHistorySchema = z.object({ customerId, days });
const ReadTemplateRegistrySchema = z.object({ category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional() });
const ReadRecentMessagesSchema = z.object({ customerId, limit });
const ReadOrderHistorySchema = z.object({ customerId, days });

const WriteInsightsFeedSchema = z.object({
  kind: z.enum(['replenishment_due', 'churn_risk_spike', 'opportunity', 'anomaly']),
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  ctaAction: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(1).max(5),
  expiresInHours: z.number().int().min(1).max(720).optional(),
});

const WriteLeadSchema = z.object({
  source: z.enum(['whatsapp', 'website_form', 'manual', 'referral']),
  phone: z.string().optional(),
  name: z.string().optional(),
  pincode: z.string().optional(),
  interest: z.string().optional(),
  notes: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const WriteInboxMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  kind: z.enum(['auto_reply', 'internal_note']),
});

const WriteConsentWithdrawalSchema = z.object({
  customerId,
  purposes: z.array(z.string()).min(1),
  source: z.enum(['stop_keyword', 'web_form', 'manual', 'unsubscribe_link']),
});

const WriteComplianceDecisionSchema = z.object({
  campaignId: z.string().uuid(),
  verdict: z.enum(['pass', 'warn', 'block']),
  reasons: z.array(z.string()),
  removedRecipientIds: z.array(z.string().uuid()).optional(),
});

// ─── Factory: wraps the call-admin-api pattern uniformly ────────────────────

interface ToolDef {
  /** Short name used in chatagent registry: "swarg-food.<name>" */
  name: string;
  /** Path on swarg-admin-nextjs side */
  path: string;
  method: 'GET' | 'POST';
  /** Zod validator on input */
  schema: z.ZodTypeAny;
}

function makeHandler(def: ToolDef): GatewayHandler {
  return async (params, ctx): Promise<ToolExecutionResult> => {
    const startedAt = Date.now();
    const parse = def.schema.safeParse(params);
    if (!parse.success) {
      return {
        success: false,
        data: null,
        error: { code: 'INVALID_INPUT', message: parse.error.message },
        durationMs: Date.now() - startedAt,
      };
    }
    try {
      const requestId = uuidv4();
      const data = await callAdminApi({
        method: def.method,
        path: def.path,
        ...(def.method === 'GET'
          ? { query: parse.data as Record<string, string | number | undefined> }
          : { body: parse.data }),
        requestId,
        agentSlug: ctx.tenantId, // ctx doesn't carry slug; agent loop's logging is the audit trail
      });
      return {
        success: true,
        data,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const isAdminErr = err instanceof AdminApiError;
      log.warn({ tool: def.name, err }, 'LMS tool call failed');
      return {
        success: false,
        data: null,
        error: {
          code: isAdminErr ? `ADMIN_API_${err.status ?? 'ERR'}` : 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        },
        durationMs: Date.now() - startedAt,
      };
    }
  };
}

const TOOLS: ToolDef[] = [
  // Reads
  { name: 'read_consent_state',    method: 'GET',  path: '/api/agent-tools/lms/read-consent-state',    schema: ReadConsentSchema },
  { name: 'read_rfm_score',        method: 'GET',  path: '/api/agent-tools/lms/read-rfm-score',        schema: ReadRfmSchema },
  { name: 'read_health_score',     method: 'GET',  path: '/api/agent-tools/lms/read-health-score',     schema: ReadHealthSchema },
  { name: 'read_campaign_history', method: 'GET',  path: '/api/agent-tools/lms/read-campaign-history', schema: ReadCampaignHistorySchema },
  { name: 'read_template_registry',method: 'GET',  path: '/api/agent-tools/lms/read-template-registry',schema: ReadTemplateRegistrySchema },
  { name: 'read_recent_messages',  method: 'GET',  path: '/api/agent-tools/lms/read-recent-messages',  schema: ReadRecentMessagesSchema },
  { name: 'read_order_history',    method: 'GET',  path: '/api/agent-tools/lms/read-order-history',    schema: ReadOrderHistorySchema },
  // Writes (category 'write' in the tools table — short-circuited under shadowMode)
  { name: 'write_insights_feed',        method: 'POST', path: '/api/agent-tools/lms/write-insights-feed',        schema: WriteInsightsFeedSchema },
  { name: 'write_lead',                 method: 'POST', path: '/api/agent-tools/lms/write-lead',                 schema: WriteLeadSchema },
  { name: 'write_inbox_message',        method: 'POST', path: '/api/agent-tools/lms/write-inbox-message',        schema: WriteInboxMessageSchema },
  { name: 'write_consent_withdrawal',   method: 'POST', path: '/api/agent-tools/lms/write-consent-withdrawal',   schema: WriteConsentWithdrawalSchema },
  { name: 'write_compliance_decision',  method: 'POST', path: '/api/agent-tools/lms/write-compliance-decision',  schema: WriteComplianceDecisionSchema },
];

export function registerLmsTools() {
  for (const def of TOOLS) {
    registerHandler(`swarg-food.${def.name}`, makeHandler(def));
  }
  log.info({ count: TOOLS.length }, 'Registered LMS tool handlers');
}
