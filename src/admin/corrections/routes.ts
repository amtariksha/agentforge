import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { correctionRules, messages as messagesTable, conversations } from '../../shared/schema/index.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import type { JwtPayload } from '../../shared/middleware/auth.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'corrections' });

export async function correctionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // === Level 1: Immediate Fix (specific response) ===
  app.post<{
    Body: {
      messageId: string;
      correctedText: string;
      sendToUser: boolean;
      apologyPrefix?: string;
    };
  }>('/admin/corrections/immediate', async (request, reply) => {
    const auth = (request as typeof request & { auth: JwtPayload }).auth;
    const { messageId, correctedText, sendToUser, apologyPrefix } = request.body;

    // Update the message
    await db.update(messagesTable)
      .set({
        wasCorrected: true,
        correction: {
          originalText: null, // Will be populated
          correctedText,
          correctedBy: auth.agentId,
          correctedAt: new Date().toISOString(),
          sentToUser: sendToUser,
        },
      })
      .where(eq(messagesTable.id, messageId));

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
  app.post<{
    Params: { tenantId: string };
    Body: {
      pattern: string;
      instruction: string;
      examples?: { bad: string; good: string }[];
      appliesToAgents?: string[];
    };
  }>('/admin/corrections/rules/:tenantId', async (request, reply) => {
    const auth = (request as typeof request & { auth: JwtPayload }).auth;
    const { pattern, instruction, examples, appliesToAgents } = request.body;

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
  });

  // Update correction rule
  app.put<{
    Params: { tenantId: string; id: string };
    Body: {
      pattern?: string;
      instruction?: string;
      examples?: { bad: string; good: string }[];
      appliesToAgents?: string[];
      isActive?: boolean;
    };
  }>('/admin/corrections/rules/:tenantId/:id', async (request, reply) => {
    const body = request.body;

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
  });

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
 * Load active correction rules for a tenant + agent type.
 * Returns formatted strings to inject into the dynamic prompt block.
 */
export async function loadActiveCorrections(
  tenantId: string,
  agentSlug?: string,
): Promise<string[]> {
  const rules = await db
    .select({ pattern: correctionRules.pattern, instruction: correctionRules.instruction, id: correctionRules.id })
    .from(correctionRules)
    .where(and(eq(correctionRules.tenantId, tenantId), eq(correctionRules.isActive, true)));

  return rules
    .filter(r => {
      // If rule specifies agent types, check match
      // appliesToAgents is in the DB but not loaded here yet — filter if needed
      return true;
    })
    .map(r => `${r.instruction} (#${r.id.slice(0, 8)})`);
}
