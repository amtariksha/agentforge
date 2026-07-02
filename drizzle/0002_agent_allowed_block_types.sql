-- M2 generative UI: per-agent block-type whitelist.
-- Additive, nullable (NULL = allow all block types). Applied via drizzle-kit push
-- OR this file: psql "$DATABASE_URL" -f drizzle/0002_agent_allowed_block_types.sql
ALTER TABLE agent_types ADD COLUMN IF NOT EXISTS allowed_block_types jsonb;
