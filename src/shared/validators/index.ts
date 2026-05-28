import { z } from 'zod';

// Admin auth
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  tenantId: z.string().uuid().optional(),
  // Alternative to tenantId — useful for sub-portal deployments that know
  // the tenant by slug but not by uuid. Mutually exclusive with tenantId
  // when both are present (slug is resolved to id and must match).
  tenantSlug: z.string().min(1).optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// Tenant
export const createTenantSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  config: z.record(z.unknown()),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

// Agent types
export const createAgentTypeSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  avatarEmoji: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().min(1),
  intentKeywords: z.array(z.string()).default([]),
  intentExamples: z.array(z.string()).default([]),
  priority: z.number().int().default(0),
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  isDefault: z.boolean().default(false),
  modelOverride: z.string().nullable().optional(),
  shadowMode: z.boolean().default(false),
  // Accept number (UI) or string (DB numeric type) or null (unlimited).
  dailySpendCapUsd: z.union([z.number().nonnegative(), z.string()]).nullable().optional(),
});

export const updateAgentTypeSchema = createAgentTypeSchema.partial();

// Tools
export const createToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['read', 'write', 'destructive']).default('read'),
  requiresHitl: z.boolean().default(false),
  requiresUserConfirm: z.boolean().default(false),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.object({
      type: z.string(),
      description: z.string(),
      enum: z.array(z.string()).optional(),
    })),
    required: z.array(z.string()),
  }),
  backendMapping: z.object({
    type: z.enum(['external', 'internal']),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
    endpoint: z.string().optional(),
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.record(z.unknown()).optional(),
    responseMapping: z.object({
      successField: z.string(),
      dataField: z.string(),
      errorField: z.string(),
    }).optional(),
    handler: z.string().optional(),
  }),
  executionConfig: z.object({
    timeoutMs: z.number().int().min(1000).max(30000).default(5000),
    retryCount: z.number().int().min(0).max(3).default(1),
    fallbackMessage: z.string().default('This action could not be completed. Please try again.'),
  }).optional(),
});

// Guardrails
export const createGuardrailSchema = z.object({
  name: z.string().min(1),
  ruleType: z.enum(['keyword_block', 'regex_filter', 'topic_restriction', 'sentiment_filter', 'pii_detection', 'length_limit']),
  config: z.record(z.unknown()),
  action: z.enum(['block', 'warn', 'flag', 'redact']).default('block'),
  triggerResponse: z.string().optional(),
  appliesTo: z.enum(['input', 'output', 'both']).default('input'),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// Tickets
export const createTicketSchema = z.object({
  source: z.enum(['auto_escalation', 'user_request', 'operator_created', 'system_alert', 'hitl_approval', 'guardrail_flag']),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  type: z.enum(['complaint', 'inquiry', 'refund_request', 'approval_needed', 'agent_error', 'general']),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  subject: z.string().min(1),
  description: z.string().optional(),
});

export const updateTicketSchema = z.object({
  status: z.enum(['open', 'in_progress', 'waiting_on_user', 'waiting_on_backend', 'resolved', 'closed', 'reopened']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  resolution: z.object({
    type: z.string(),
    notes: z.string(),
    actionsTaken: z.array(z.string()),
  }).optional(),
});

// Human agents
export const createHumanAgentSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
  role: z.enum(['super_admin', 'admin', 'operator', 'viewer']).default('operator'),
  maxConcurrentChats: z.number().int().min(1).max(20).default(5),
  skills: z.array(z.string()).default([]),
});

// Webhook configs
export const createWebhookConfigSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  secret: z.string().optional(),
});

// Pagination
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
