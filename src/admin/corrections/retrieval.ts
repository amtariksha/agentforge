/**
 * Retrieval of past operator corrections for injection into the dynamic prompt
 * block ("Learned Corrections"). Reuses the knowledge-base pgvector embedder +
 * the same cosine-distance query pattern as searchKnowledge.
 *
 * Scoped tenant_id + (agent slug OR global). Retrieved text is customer-derived
 * → never logged (only counts/scores), never added to traces. Always injected
 * BELOW the prompt cache boundary (see prompt-builder.ts).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db.js';
import { generateEmbedding } from '../../memory/knowledge-base.js';
import { createChildLogger } from '../../shared/utils/logger.js';

const log = createChildLogger({ module: 'corrections-retrieval' });

const TOP_K = 3;
const MIN_SIMILARITY = 0.5;   // cosine sim on text-embedding-3-small; excludes unrelated, tolerates paraphrase
const USER_TEXT_MAX = 160;
const CORRECTED_MAX = 240;
const BLOCK_CHAR_CAP = 2400;  // ~600 tokens for the whole block

export interface PastCorrection {
  userText: string | null;
  originalText: string | null;
  correctedText: string;
  score: number;
}

/**
 * Retrieve the top-K most similar past corrections for this tenant + agent.
 * Returns [] when embeddings are unavailable (no OPENAI_API_KEY or a zero-vector
 * fallback), since cosine scores against a zero vector are meaningless.
 */
export async function searchPastCorrections(
  tenantId: string,
  agentSlug: string,
  queryText: string,
  topK: number = TOP_K,
  minSimilarity: number = MIN_SIMILARITY,
): Promise<PastCorrection[]> {
  if (!process.env.OPENAI_API_KEY || !queryText.trim()) return [];

  const queryEmbedding = await generateEmbedding(queryText);
  if (queryEmbedding.every((v) => v === 0)) return [];

  const vecLiteral = `'[${queryEmbedding.join(',')}]'::vector`;
  const results = await db.execute(sql`
    SELECT
      mc.user_text,
      mc.original_text,
      mc.corrected_text,
      1 - (mc.embedding <=> ${sql.raw(vecLiteral)}) AS score
    FROM message_corrections mc
    WHERE mc.tenant_id = ${tenantId}
      AND (mc.agent_type_slug = ${agentSlug} OR mc.agent_type_slug IS NULL)
      AND mc.embedding IS NOT NULL
    ORDER BY mc.embedding <=> ${sql.raw(vecLiteral)}
    LIMIT ${topK}
  `);

  const rows = (results.rows as Array<{
    user_text: string | null;
    original_text: string | null;
    corrected_text: string;
    score: number;
  }>)
    .map((r) => ({
      userText: r.user_text,
      originalText: r.original_text,
      correctedText: r.corrected_text,
      score: Number(r.score),
    }))
    .filter((r) => r.score >= minSimilarity);

  log.info({ tenantId, agentSlug, hits: rows.length, topScore: rows[0]?.score }, 'Past corrections retrieved');
  return rows;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Render structured corrections into prompt bullet strings. Highest-score first;
 * drops lowest-score items once the block exceeds the char cap. Kept here so the
 * prompt builder stays a pure renderer of strings.
 */
export function formatPastCorrections(rows: PastCorrection[]): string[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  let total = 0;
  for (const r of sorted) {
    const asked = r.userText ? truncate(r.userText, USER_TEXT_MAX) : '(similar question)';
    const line = `When the customer asked: "${asked}" — the correct answer is: "${truncate(r.correctedText, CORRECTED_MAX)}"`;
    if (total + line.length > BLOCK_CHAR_CAP) break;
    lines.push(line);
    total += line.length;
  }
  return lines;
}
