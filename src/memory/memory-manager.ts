import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { users, memoryTopics, messages as messagesTable } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'memory' });

const MAX_INDEX_ENTRIES = 20;
const MAX_INDEX_ENTRY_LENGTH = 150;
const MAX_TOPIC_TOKENS = 5000;

/**
 * Layer 1: Memory Index
 * Always in context (~300 tokens). One-line pointers to topics.
 * Format: "key → topic | summary"
 */
export async function getMemoryIndex(userId: string, tenantId: string): Promise<string | null> {
  const [user] = await db.select({ memoryIndex: users.memoryIndex }).from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);

  if (!user?.memoryIndex) return null;

  const index = user.memoryIndex as Record<string, string>;
  const entries = Object.entries(index).slice(0, MAX_INDEX_ENTRIES);
  if (entries.length === 0) return null;

  return entries.map(([key, summary]) => `${key} → ${summary}`).join('\n');
}

/**
 * Layer 2: Topic Files (on-demand)
 * Retrieved when the agent needs details about a specific topic.
 */
export async function getTopicFile(
  userId: string,
  tenantId: string,
  topicKey: string,
): Promise<Record<string, unknown> | null> {
  const [topic] = await db.select()
    .from(memoryTopics)
    .where(and(
      eq(memoryTopics.userId, userId),
      eq(memoryTopics.tenantId, tenantId),
      eq(memoryTopics.topicKey, topicKey),
    ))
    .limit(1);

  if (!topic) return null;

  // Update last accessed
  await db.update(memoryTopics)
    .set({ lastAccessedAt: new Date() })
    .where(eq(memoryTopics.id, topic.id));

  return topic.content as Record<string, unknown>;
}

/**
 * Layer 3: Raw Transcripts (search only)
 * Search conversation history by keyword for specific identifiers.
 */
export async function searchTranscripts(
  userId: string,
  tenantId: string,
  query: string,
  limit: number = 5,
): Promise<Array<{ text: string; createdAt: Date | null }>> {
  // Get conversations for this user
  const results = await db.execute(sql`
    SELECT m.content->>'text' as text, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ${userId}
      AND c.tenant_id = ${tenantId}
      AND m.content->>'text' ILIKE ${'%' + query + '%'}
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);

  return (results.rows as Array<{ text: string; created_at: Date }>).map(r => ({
    text: r.text,
    createdAt: r.created_at,
  }));
}

/**
 * Update memory index after a confirmed action.
 * Strict Write Discipline: only update after verified success.
 */
export async function updateMemoryIndex(
  userId: string,
  tenantId: string,
  key: string,
  summary: string,
): Promise<void> {
  const truncatedSummary = summary.slice(0, MAX_INDEX_ENTRY_LENGTH);

  const [user] = await db.select({ memoryIndex: users.memoryIndex }).from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);

  const currentIndex = (user?.memoryIndex as Record<string, string>) ?? {};

  // Enforce max entries — remove oldest if at limit
  const entries = Object.entries(currentIndex);
  if (entries.length >= MAX_INDEX_ENTRIES && !(key in currentIndex)) {
    // Remove first entry (oldest, assuming insertion order)
    const [oldestKey] = entries[0];
    delete currentIndex[oldestKey];
  }

  currentIndex[key] = truncatedSummary;

  await db.update(users)
    .set({ memoryIndex: currentIndex, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));

  log.info({ userId, key }, 'Memory index updated');
}

/**
 * Update a topic file (Layer 2).
 */
export async function updateTopicFile(
  userId: string,
  tenantId: string,
  topicKey: string,
  content: Record<string, unknown>,
): Promise<void> {
  const contentStr = JSON.stringify(content);
  // Rough token estimate: 1 token ≈ 4 chars
  const tokenEstimate = Math.ceil(contentStr.length / 4);

  if (tokenEstimate > MAX_TOPIC_TOKENS) {
    log.warn({ userId, topicKey, tokens: tokenEstimate }, 'Topic file exceeds token limit');
  }

  await db.insert(memoryTopics).values({
    userId,
    tenantId,
    topicKey,
    content,
    tokenCount: tokenEstimate,
    lastAccessedAt: new Date(),
  }).onConflictDoUpdate({
    target: [memoryTopics.userId, memoryTopics.tenantId, memoryTopics.topicKey],
    set: {
      content,
      tokenCount: tokenEstimate,
      lastAccessedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  log.info({ userId, topicKey, tokens: tokenEstimate }, 'Topic file updated');
}

/**
 * Get all topic keys for a user (for memory index rebuild during consolidation).
 */
export async function getTopicKeys(userId: string, tenantId: string): Promise<string[]> {
  const topics = await db.select({ topicKey: memoryTopics.topicKey })
    .from(memoryTopics)
    .where(and(eq(memoryTopics.userId, userId), eq(memoryTopics.tenantId, tenantId)));
  return topics.map(t => t.topicKey);
}
