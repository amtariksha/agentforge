-- Applied AFTER `drizzle-kit push` creates the message_corrections table from
-- the Drizzle schema. Adds the pgvector column + cosine index + RLS policy that
-- Drizzle can't express natively. Same pattern as knowledge_chunks in
-- 0000_init.sql. Apply with:  psql "$DATABASE_URL" -f drizzle/0001_message_corrections.sql

-- pgvector extension is already enabled by 0000_init.sql; harmless if re-run.
CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding of "<preceding user message>\n<corrected text>" (text-embedding-3-small, 1536 dims).
ALTER TABLE message_corrections ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_message_corrections_embedding
  ON message_corrections USING ivfflat (embedding vector_cosine_ops);

-- Tenant isolation (defense-in-depth beneath application filtering).
-- DROP-then-CREATE so this file is safe to re-apply on every deploy.
DROP POLICY IF EXISTS tenant_isolation_message_corrections ON message_corrections;
CREATE POLICY tenant_isolation_message_corrections ON message_corrections
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE message_corrections ENABLE ROW LEVEL SECURITY;
