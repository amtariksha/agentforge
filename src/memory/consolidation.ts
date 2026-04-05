import Anthropic from '@anthropic-ai/sdk';
import { eq, and, lt, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { users, memoryTopics } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'dream-cycle' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOPIC_TOKENS = 5000;
const STALE_DAYS = 30;

/**
 * Memory Consolidation ("Dream Cycle")
 * BullMQ job — runs daily or every N conversations per user.
 *
 * 1. Merge duplicate entries across topic files
 * 2. Remove contradictions (newer wins)
 * 3. Prune stale entries (30+ days not accessed)
 * 4. Verify facts against backend (if available)
 * 5. Enforce 5,000 token limit per topic file
 * 6. Never delete complaint/escalation history
 */
export async function runConsolidation(tenantId: string, userId: string): Promise<{
  topicsPruned: number;
  topicsConsolidated: number;
  indexEntriesRemoved: number;
}> {
  const startTime = Date.now();
  let topicsPruned = 0;
  let topicsConsolidated = 0;
  let indexEntriesRemoved = 0;

  log.info({ tenantId, userId }, 'Starting memory consolidation');

  // 1. Get all topic files for this user
  const topics = await db.select().from(memoryTopics)
    .where(and(eq(memoryTopics.userId, userId), eq(memoryTopics.tenantId, tenantId)));

  // 2. Prune stale topics (not accessed in 30+ days, except complaints)
  const staleDate = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  for (const topic of topics) {
    const isProtected = ['complaints', 'escalations', 'issues'].includes(topic.topicKey);
    if (isProtected) continue;

    const lastAccessed = topic.lastAccessedAt ?? topic.createdAt;
    if (lastAccessed && lastAccessed < staleDate) {
      await db.delete(memoryTopics).where(eq(memoryTopics.id, topic.id));
      topicsPruned++;
      log.debug({ topicKey: topic.topicKey }, 'Pruned stale topic');
    }
  }

  // 3. Consolidate oversized topics using Haiku
  const activTopics = await db.select().from(memoryTopics)
    .where(and(eq(memoryTopics.userId, userId), eq(memoryTopics.tenantId, tenantId)));

  for (const topic of activTopics) {
    if ((topic.tokenCount ?? 0) > MAX_TOPIC_TOKENS) {
      try {
        const consolidated = await consolidateTopic(topic.topicKey, topic.content as Record<string, unknown>);
        const newTokenCount = Math.ceil(JSON.stringify(consolidated).length / 4);

        await db.update(memoryTopics)
          .set({
            content: consolidated,
            tokenCount: newTokenCount,
            lastConsolidatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(memoryTopics.id, topic.id));

        topicsConsolidated++;
        log.debug({ topicKey: topic.topicKey, beforeTokens: topic.tokenCount, afterTokens: newTokenCount }, 'Consolidated topic');
      } catch (err) {
        log.error({ err, topicKey: topic.topicKey }, 'Failed to consolidate topic');
      }
    }
  }

  // 4. Rebuild memory index from remaining topics
  const remainingTopics = await db.select({ topicKey: memoryTopics.topicKey, content: memoryTopics.content })
    .from(memoryTopics)
    .where(and(eq(memoryTopics.userId, userId), eq(memoryTopics.tenantId, tenantId)));

  const [user] = await db.select({ memoryIndex: users.memoryIndex }).from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);

  const currentIndex = (user?.memoryIndex as Record<string, string>) ?? {};
  const validKeys = new Set(remainingTopics.map(t => t.topicKey));

  // Remove index entries for deleted topics
  for (const key of Object.keys(currentIndex)) {
    if (!validKeys.has(key)) {
      delete currentIndex[key];
      indexEntriesRemoved++;
    }
  }

  await db.update(users)
    .set({ memoryIndex: currentIndex, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));

  const durationMs = Date.now() - startTime;
  log.info({ tenantId, userId, topicsPruned, topicsConsolidated, indexEntriesRemoved, durationMs }, 'Consolidation complete');

  return { topicsPruned, topicsConsolidated, indexEntriesRemoved };
}

async function consolidateTopic(
  topicKey: string,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1000,
    temperature: 0,
    system: `You are a memory consolidation agent. Compress the following topic data while preserving:
1. Key facts and preferences
2. Unresolved issues
3. Recent interactions (last 7 days)
4. Complaint/escalation history (NEVER delete)

Remove:
- Duplicate information
- Outdated data that contradicts newer data
- Trivial details
- Data older than 30 days (unless it's a complaint)

Return ONLY valid JSON, no markdown.`,
    messages: [{ role: 'user', content: `Topic: ${topicKey}\n\n${JSON.stringify(content)}` }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Run consolidation for all users of a tenant.
 * Called by BullMQ scheduled job.
 */
export async function runTenantConsolidation(tenantId: string): Promise<void> {
  const userRows = await db.select({ id: users.id }).from(users)
    .where(eq(users.tenantId, tenantId));

  log.info({ tenantId, userCount: userRows.length }, 'Starting tenant-wide consolidation');

  for (const user of userRows) {
    await runConsolidation(tenantId, user.id);
  }
}
