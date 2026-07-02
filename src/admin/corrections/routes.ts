import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import {
  correctionRules, messages as messagesTable, conversations, messageCorrections,
} from '../../shared/schema/index.js';
import { authMiddleware, getActiveTenantId } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { generateEmbedding } from '../../memory/knowledge-base.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'corrections' });

const immediateBodySchema = z.object({
  messageId: z.string().uuid(),
  correctedText: z.string().min(1).max(4000),
  sendToUser: z.boolean(),
  apologyPrefix: z.string().max(500).optional(),
});

const ruleExampleSchema = z.object({ bad: z.string(), good: z.string() });

const ruleCreateSchema = z.object({
  pattern: z.string().min(1).max(2000),
  instruction: z.string().min(1).max(4000),
  examples: z.array(ruleExampleSchema).optional(),
  appliesToAgents: z.array(z.string()).optional(),
});

const ruleUpdateSchema = z.object({
  pattern: z.string().min(1).max(2000).optional(),
  instruction: z.string().min(1).max(4000).optional(),
  examples: z.array(ruleExampleSchema).optional(),
  appliesToAgents: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export async function correctionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // === Level 1: Immediate Fix (specific response) ===
  app.post('/admin/corrections/immediate', async (request, reply) => {
    const auth = (request as typeof request & { auth: JwtPayload }).auth;
    const tenantId = getActiveTenantId(request);

    const parsed = immediateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { messageId, correctedText, sendToUser } = parsed.data;

    // Tenant-scoped lookup — an admin from tenant A must not touch tenant B's rows.
    const [msg] = await db
      .select({
        id: messagesTable.id,
        conversationId: messagesTable.conversationId,
        content: messagesTable.content,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.id, messageId), eq(messagesTable.tenantId, tenantId)))
      .limit(1);

    if (!msg) {
      return reply.status(404).send({ error: 'Message not found' });
    }

    const originalText = (msg.content as { text?: string } | null)?.text ?? null;

    await db.update(messagesTable)
      .set({
        wasCorrected: true,
        correction: {
          originalText,
          correctedText,
          correctedBy: auth.agentId,
          correctedAt: new Date().toISOString(),
          sentToUser: sendToUser,
        },
      })
      .where(and(eq(messagesTable.id, messageId), eq(messagesTable.tenantId, tenantId)));

    // Persist a retrievable, embedded correction. A failure here must never fail
    // the correction capture — insert with NULL embedding; retrieval skips NULLs.
    try {
      await captureMessageCorrection(tenantId, msg.conversationId, msg.createdAt, originalText, correctedText, messageId);
    } catch (err) {
      log.error({ err, messageId }, 'Failed to persist embedded message correction (correction still applied)');
    }

    // If sendToUser, the corrected message needs to be delivered via channel
    // TODO: Route through channel adapter

    log.info({ messageId, correctedBy: auth.agentId, sentToUser: sendToUser }, 'Immediate correction applied');

    return reply.send({ corrected: true, messageId });
  });

  // === Level 2: Session Rule (via whisper — handled in live-chat/manager.ts) ===
  // Session rules are implemented as whispers injected into the conversation's sessionState

  // === Level 3: Permanent Rules ===

  // List permanent correction rules for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/corrections/rules/:tenantId',
    async (request, reply) => {
      const rules = await db
        .select()
        .from(correctionRules)
        .where(eq(correctionRules.tenantId, request.params.tenantId))
        .orderBy(desc(correctionRules.createdAt));

      return reply.send(rules);
    },
  );

  // Create permanent correction rule
  app.post<{ Params: { tenantId: string } }>(
    '/admin/corrections/rules/:tenantId',
    async (request, reply) => {
      const auth = (request as typeof request & { auth: JwtPayload }).auth;

      const parsed = ruleCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
      }
      const { pattern, instruction, examples, appliesToAgents } = parsed.data;

      const [rule] = await db.insert(correctionRules).values({
        tenantId: request.params.tenantId,
        pattern,
        instruction,
        examples: examples ?? null,
        appliesToAgents: appliesToAgents ?? null,
        createdBy: auth.agentId,
      }).returning();

      log.info({ ruleId: rule.id, pattern }, 'Permanent correction rule created');
      return reply.status(201).send(rule);
    },
  );

  // Update correction rule
  app.put<{ Params: { tenantId: string; id: string } }>(
    '/admin/corrections/rules/:tenantId/:id',
    async (request, reply) => {
      const parsed = ruleUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
      }
      const body = parsed.data;

      const [updated] = await db.update(correctionRules)
        .set({
          ...(body.pattern !== undefined && { pattern: body.pattern }),
          ...(body.instruction !== undefined && { instruction: body.instruction }),
          ...(body.examples !== undefined && { examples: body.examples }),
          ...(body.appliesToAgents !== undefined && { appliesToAgents: body.appliesToAgents }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        })
        .where(and(
          eq(correctionRules.tenantId, request.params.tenantId),
          eq(correctionRules.id, request.params.id),
        ))
        .returning();

      if (!updated) return reply.status(404).send({ error: 'Rule not found' });
      return reply.send(updated);
    },
  );

  // Delete correction rule
  app.delete<{ Params: { tenantId: string; id: string } }>(
    '/admin/corrections/rules/:tenantId/:id',
    async (request, reply) => {
      await db.delete(correctionRules)
        .where(and(
          eq(correctionRules.tenantId, request.params.tenantId),
          eq(correctionRules.id, request.params.id),
        ));

      return reply.send({ deleted: true });
    },
  );
}

/**
 * Store an embedded, retrievable message correction. Embeds
 * "<preceding user message>\n<corrected text>" so retrieval can match on the
 * context in which the correction applies. Never logs the text (PII).
 */
async function captureMessageCorrection(
  tenantId: string,
  conversationId: string,
  correctedAt: Date | null,
  originalText: string | null,
  correctedText: string,
  sourceMessageId: string,
): Promise<void> {
  const [conv] = await db
    .select({ currentAgentType: conversations.currentAgentType })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
    .limit(1);

  // Nearest preceding user message = the question this correction answers.
  const [priorUser] = await db
    .select({ content: messagesTable.content })
    .from(messagesTable)
    .where(and(
      eq(messagesTable.conversationId, conversationId),
      eq(messagesTable.tenantId, tenantId),
      eq(messagesTable.senderType, 'user'),
      ...(correctedAt ? [lt(messagesTable.createdAt, correctedAt)] : []),
    ))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);

  const userText = (priorUser?.content as { text?: string } | undefined)?.text ?? null;

  const [row] = await db.insert(messageCorrections).values({
    tenantId,
    agentTypeSlug: conv?.currentAgentType ?? null,
    sourceMessageId,
    userText,
    originalText,
    correctedText,
  }).returning({ id: messageCorrections.id });

  const embedding = await generateEmbedding(`${userText ?? ''}\n${correctedText}`);
  if (embedding.every((v) => v === 0)) return; // no OPENAI_API_KEY / embed failure — leave NULL

  await db.execute(sql`
    UPDATE message_corrections
    SET embedding = ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
    WHERE id = ${row.id} AND tenant_id = ${tenantId}
  `);
}

/**
 * Load active correction rules for a tenant + agent type. Returns formatted
 * strings to inject into the dynamic prompt block ("## Active Corrections").
 * A rule with no `appliesToAgents` (null/empty) applies to every agent.
 */
export async function loadActiveCorrections(
  tenantId: string,
  agentSlug?: string,
): Promise<string[]> {
  const rules = await db
    .select({
      id: correctionRules.id,
      instruction: correctionRules.instruction,
      appliesToAgents: correctionRules.appliesToAgents,
    })
    .from(correctionRules)
    .where(and(eq(correctionRules.tenantId, tenantId), eq(correctionRules.isActive, true)));

  return rules
    .filter((r) => {
      if (!agentSlug) return true;
      const scope = r.appliesToAgents;
      return scope == null || scope.length === 0 || scope.includes(agentSlug);
    })
    .map((r) => `${r.instruction} (#${r.id.slice(0, 8)})`);
}
