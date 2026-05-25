import { defineConfig } from 'drizzle-kit';
import { existsSync } from 'node:fs';

// Use compiled JS schema when running inside the production Docker image
// (drizzle-kit's CJS resolver can't load TS source whose imports use `.js`
// extensions). Fall back to TS source for local development.
const compiledSchema = './dist/src/shared/schema/index.js';
const schema = existsSync(compiledSchema)
  ? compiledSchema
  : './src/shared/schema/index.ts';

export default defineConfig({
  schema,
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge',
  },
});
