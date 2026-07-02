/**
 * Vitest global setup. Runs before any test-file imports, so module-load-time
 * env reads (llm-provider.ts PROVIDER/client constants, shared/redis.ts,
 * shared/db.ts) see deterministic values. No network is ever touched: the db
 * pool and redis client are mocked per-suite; the SDK clients are mocked or
 * constructed against dummy keys and never invoked live.
 */
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'anthropic';
process.env.LLM_FALLBACK_PROVIDER = process.env.LLM_FALLBACK_PROVIDER ?? 'anthropic';
process.env.LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL ?? 'claude-haiku-4-5';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// Keep pino quiet during tests unless a suite opts in.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
