/**
 * Manual, dev-only live check for the LLM fallback chain. NOT run in CI.
 *
 * Stands up a one-shot local HTTP server that answers every request with a
 * `529 overloaded_error`, points the PRIMARY Anthropic client at it via
 * ANTHROPIC_BASE_URL, and leaves the fallback pointed at the real API. It then
 * runs one agent turn and prints the newest llm_usage_logs row — which should
 * show the FALLBACK provider/model, with exactly one `llm_fallback` warn in the
 * logs above.
 *
 * Prerequisites:
 *   - A running Postgres with the schema migrated + model_pricing seeded.
 *   - A real ANTHROPIC_API_KEY in the env (used for the fallback hop).
 *   - A seeded tenant + agent slug to exercise (edit TENANT_ID / AGENT_SLUG).
 *
 * Because ANTHROPIC_BASE_URL is read by the SDK at construction time (inside
 * llm-provider.ts, imported transitively), we set it BEFORE importing anything
 * that constructs the client.
 *
 * Usage:
 *   TENANT_ID=<uuid> AGENT_SLUG=<slug> npx tsx scripts/manual/fallback-check.ts
 *
 * Negative check: run with an INVALID ANTHROPIC_API_KEY and no base-url override
 * → the primary returns 401, which is NON-retryable, so NO fallback fires and no
 * usage row is written. That confirms the classifier's 4xx handling.
 */
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

const TENANT_ID = process.env.TENANT_ID;
const AGENT_SLUG = process.env.AGENT_SLUG ?? 'support';

async function main() {
  if (!TENANT_ID) {
    console.error('Set TENANT_ID (and optionally AGENT_SLUG) to a seeded tenant/agent.');
    process.exit(1);
  }

  // One-shot 529 server for the PRIMARY endpoint.
  const server = createServer((_req, res) => {
    res.writeHead(529, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded (simulated)' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  // Point the PRIMARY client at the 529 server; keep the fallback on the real API.
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.LLM_FALLBACK_PROVIDER = process.env.LLM_FALLBACK_PROVIDER ?? 'anthropic';
  process.env.LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL ?? 'claude-haiku-4-5';

  // Import AFTER env is set so module-load-time client construction picks it up.
  const { streamAgentBySlug } = await import('../../src/orchestrator/agent-stream.js');
  const { db, pool } = await import('../../src/shared/db.js');
  const { llmUsageLogs } = await import('../../src/shared/schema/index.js');
  const { desc } = await import('drizzle-orm');

  console.log(`Primary → 529 server at :${port}. Fallback → ${process.env.LLM_FALLBACK_MODEL}. Running one turn...`);

  const result = await streamAgentBySlug({
    tenantId: TENANT_ID,
    agentSlug: AGENT_SLUG,
    sessionId: `fallback-check-${port}`,
    userMessage: 'Hello — this is a fallback smoke test.',
    onEvent: (e) => { if (e.type === 'error') console.error('stream error:', e.message); },
  });

  console.log('finalText:', result.finalText.slice(0, 120));

  const [row] = await db.select().from(llmUsageLogs).orderBy(desc(llmUsageLogs.createdAt)).limit(1);
  console.log('newest llm_usage_logs row:', {
    provider: row?.provider,
    model: row?.model,
    tokensInput: row?.tokensInput,
    tokensOutput: row?.tokensOutput,
    costUsd: row?.costUsd,
    pricingId: row?.pricingId,
  });
  console.log('EXPECT: provider/model = fallback, one `llm_fallback` warn logged above.');

  server.close();
  await pool.end();
}

main().catch((err) => {
  console.error('fallback-check failed:', err);
  process.exit(1);
});
