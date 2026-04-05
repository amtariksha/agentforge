import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/shared/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge',
  },
});
