import type { FastifyInstance } from 'fastify';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { knowledgeDocuments, knowledgeChunks } from '../shared/schema/index.js';
import { authMiddleware } from '../shared/middleware/auth.js';
import { createChildLogger } from '../shared/utils/logger.js';

const log = createChildLogger({ module: 'knowledge-base' });

const CHUNK_SIZE = 500; // tokens (~2000 chars)
const CHUNK_OVERLAP = 100; // tokens (~400 chars)
const CHARS_PER_TOKEN = 4;

/**
 * Split text into overlapping chunks.
 */
function chunkText(text: string, chunkSizeTokens: number, overlapTokens: number): string[] {
  const chunkChars = chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const chunks: string[] = [];

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push(text.slice(start, end));
    start += chunkChars - overlapChars;
    if (end === text.length) break;
  }

  return chunks;
}

/**
 * Generate embedding using Anthropic/OpenAI.
 * Falls back to zero vector if no API key configured.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    log.warn('No OPENAI_API_KEY configured — using zero vector for embeddings');
    return new Array(1536).fill(0);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding API error: ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  } catch (err) {
    log.error({ err }, 'Embedding generation failed');
    return new Array(1536).fill(0);
  }
}

/**
 * Process an uploaded document: extract text, chunk, embed, store.
 */
export async function processDocument(
  tenantId: string,
  documentId: string,
  text: string,
): Promise<number> {
  const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);

  log.info({ documentId, chunks: chunks.length }, 'Processing document chunks');

  let processedCount = 0;
  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk);

    await db.execute(sql`
      INSERT INTO knowledge_chunks (id, tenant_id, document_id, content, embedding, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}, ${documentId}, ${chunk}, ${sql.raw(`'[${embedding.join(',')}]'::vector`)}, '{}', now())
    `);

    processedCount++;
  }

  // Update document status
  await db.update(knowledgeDocuments)
    .set({ chunkCount: processedCount, status: 'ready' })
    .where(eq(knowledgeDocuments.id, documentId));

  log.info({ documentId, chunks: processedCount }, 'Document processing complete');
  return processedCount;
}

/**
 * Search knowledge base using vector similarity.
 */
export async function searchKnowledge(
  tenantId: string,
  query: string,
  topK: number = 5,
): Promise<Array<{ content: string; score: number; documentId: string }>> {
  const queryEmbedding = await generateEmbedding(query);

  const results = await db.execute(sql`
    SELECT
      kc.content,
      kc.document_id,
      1 - (kc.embedding <=> ${sql.raw(`'[${queryEmbedding.join(',')}]'::vector`)}) as score
    FROM knowledge_chunks kc
    WHERE kc.tenant_id = ${tenantId}
      AND kc.embedding IS NOT NULL
    ORDER BY kc.embedding <=> ${sql.raw(`'[${queryEmbedding.join(',')}]'::vector`)}
    LIMIT ${topK}
  `);

  return (results.rows as Array<{ content: string; score: number; document_id: string }>).map(r => ({
    content: r.content,
    score: r.score,
    documentId: r.document_id,
  }));
}

/**
 * Knowledge base admin routes.
 */
export async function knowledgeBaseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // List documents for tenant
  app.get<{ Params: { tenantId: string } }>(
    '/admin/knowledge/:tenantId/documents',
    async (request, reply) => {
      const docs = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.tenantId, request.params.tenantId))
        .orderBy(desc(knowledgeDocuments.createdAt));

      return reply.send(docs);
    },
  );

  // Upload document (text content)
  app.post<{
    Params: { tenantId: string };
    Body: { filename: string; fileType: string; content: string };
  }>(
    '/admin/knowledge/:tenantId/documents',
    async (request, reply) => {
      const { filename, fileType, content } = request.body;

      if (!content?.trim()) {
        return reply.status(400).send({ error: 'Document content is required' });
      }

      // Create document record
      const [doc] = await db.insert(knowledgeDocuments).values({
        tenantId: request.params.tenantId,
        filename,
        fileType,
        status: 'processing',
      }).returning();

      // Process asynchronously
      processDocument(request.params.tenantId, doc.id, content).catch((err) => {
        log.error({ err, documentId: doc.id }, 'Document processing failed');
        db.update(knowledgeDocuments)
          .set({ status: 'failed' })
          .where(eq(knowledgeDocuments.id, doc.id))
          .catch(() => {});
      });

      return reply.status(201).send({ ...doc, message: 'Document queued for processing' });
    },
  );

  // Delete document
  app.delete<{ Params: { tenantId: string; id: string } }>(
    '/admin/knowledge/:tenantId/documents/:id',
    async (request, reply) => {
      await db.delete(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.tenantId, request.params.tenantId),
          eq(knowledgeDocuments.id, request.params.id),
        ));

      return reply.send({ deleted: true });
    },
  );

  // Search knowledge base
  app.post<{
    Params: { tenantId: string };
    Body: { query: string; topK?: number };
  }>(
    '/admin/knowledge/:tenantId/search',
    async (request, reply) => {
      const { query, topK } = request.body;

      if (!query?.trim()) {
        return reply.status(400).send({ error: 'Query is required' });
      }

      const results = await searchKnowledge(request.params.tenantId, query, topK ?? 5);
      return reply.send(results);
    },
  );
}
