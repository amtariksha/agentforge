-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add vector column to knowledge_chunks (Drizzle doesn't support vector type natively)
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops);

-- Row Level Security policies
-- Each tenant can only see their own data

-- Users
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Conversations
CREATE POLICY tenant_isolation_conversations ON conversations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Messages
CREATE POLICY tenant_isolation_messages ON messages
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Tickets
CREATE POLICY tenant_isolation_tickets ON tickets
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Tools
CREATE POLICY tenant_isolation_tools ON tools
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;

-- Guardrails (null tenant_id = global)
CREATE POLICY tenant_isolation_guardrails ON guardrails
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE guardrails ENABLE ROW LEVEL SECURITY;

-- Memory topics
CREATE POLICY tenant_isolation_memory_topics ON memory_topics
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE memory_topics ENABLE ROW LEVEL SECURITY;

-- Knowledge chunks
CREATE POLICY tenant_isolation_knowledge_chunks ON knowledge_chunks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
