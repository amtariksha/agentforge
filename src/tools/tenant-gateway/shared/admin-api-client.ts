/**
 * callAdminApi — single helper for all chatagent → swarg-admin-nextjs
 * service-to-service calls. Used by tool handlers in the tenant gateway.
 *
 * Adds the required headers per integration plan §7.2:
 *   Authorization: Bearer ${SWARG_ADMIN_SERVICE_TOKEN}
 *   X-Agent-Force-Request-Id: <uuid v4>  (idempotency key for writes)
 *   X-Agent-Force-Agent:      <agent-slug>  (audit trail)
 *   Content-Type:             application/json (body present)
 *
 * Behavior:
 *   • 10s default timeout (configurable per call).
 *   • Retry on 5xx with exponential backoff, max 3 attempts.
 *   • Does NOT retry on 4xx (caller-side bug) or aborts.
 *   • Returns parsed JSON on success. Throws AdminApiError on failure.
 */
import { createChildLogger } from '../../../shared/utils/logger.js';

const log = createChildLogger({ module: 'admin-api-client' });

const BASE_URL = (process.env.SWARG_ADMIN_BASE_URL ?? '').replace(/\/$/, '');
const SERVICE_TOKEN = process.env.SWARG_ADMIN_SERVICE_TOKEN ?? '';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export class AdminApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface CallAdminApiArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;                 // e.g. "/api/agent-tools/lms/read-consent-state"
  body?: unknown;               // serialized as JSON if present
  query?: Record<string, string | number | undefined>;
  requestId: string;            // per-call idempotency key
  agentSlug: string;            // chatagent agent slug for audit
  timeoutMs?: number;
}

export async function callAdminApi<T = unknown>(args: CallAdminApiArgs): Promise<T> {
  if (!BASE_URL) {
    throw new AdminApiError('SWARG_ADMIN_BASE_URL is not configured');
  }
  if (!SERVICE_TOKEN) {
    throw new AdminApiError('SWARG_ADMIN_SERVICE_TOKEN is not configured');
  }

  const qs = args.query
    ? '?' +
      Object.entries(args.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const url = `${BASE_URL}${args.path}${qs}`;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${SERVICE_TOKEN}`,
    'X-Agent-Force-Request-Id': args.requestId,
    'X-Agent-Force-Agent': args.agentSlug,
    Accept: 'application/json',
  };
  if (args.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: args.method,
        headers,
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: ctrl.signal,
      });

      const text = await res.text();
      const parsed = safeJson(text);

      if (res.ok) {
        return parsed as T;
      }

      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 200ms, 600ms (3x)
        const delay = 200 * Math.pow(3, attempt - 1);
        log.warn({ url, status: res.status, attempt, delay }, 'admin-api 5xx, retrying');
        await sleep(delay);
        continue;
      }

      throw new AdminApiError(
        `admin-api ${res.status} on ${args.method} ${args.path}`,
        res.status,
        parsed,
      );
    } catch (err) {
      if (err instanceof AdminApiError) throw err;
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        const delay = 200 * Math.pow(3, attempt - 1);
        log.warn({ url, err, attempt, delay }, 'admin-api transport error, retrying');
        await sleep(delay);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AdminApiError(
    `admin-api exhausted ${MAX_ATTEMPTS} attempts on ${args.method} ${args.path}`,
    undefined,
    lastError instanceof Error ? lastError.message : String(lastError),
  );
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
