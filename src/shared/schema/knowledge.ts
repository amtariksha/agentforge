import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  filename: text('filename').notNull(),
  fileType: text('file_type').notNull(),
  chunkCount: integer('chunk_count').default(0),
  status: text('status').default('processing').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Note: pgvector extension and vector column type need raw SQL for the migration
// The embedding column uses vector(1536) — handled via custom migration
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id).notNull(),
  documentId: uuid('document_id').references(() => knowledgeDocuments.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  // embedding: vector(1536) — added via raw SQL migration
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
