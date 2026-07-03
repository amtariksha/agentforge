import { eq, and, sql } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { tenantWallets, ledgerEntries } from '../shared/schema/index.js';
import type { LedgerUsageMeta } from '../shared/schema/index.js';
import { createChildLogger } from '../shared/utils/logger.js';
import { clearPausedCache } from './wallet-state.js';

const log = createChildLogger({ module: 'ledger' });

export type LedgerEntryType =
  | 'debit_usage'
  | 'debit_manual'
  | 'credit_manual'
  | 'credit_topup'
  | 'refund'
  | 'credit_bonus';

type LedgerEntry = typeof ledgerEntries.$inferSelect;
type Wallet = typeof tenantWallets.$inferSelect;

export interface ApplyLedgerInput {
  tenantId: string;
  type: LedgerEntryType;
  /** Signed decimal string: debits negative, credits positive. */
  amountUsd: string;
  /** Idempotency key, unique per tenant. A replay is a no-op returning the prior entry. */
  reference: string;
  description?: string;
  metadata?: LedgerUsageMeta;
  /** Human-agent id for manual ops; omit for system debits. */
  createdBy?: string;
}

export interface LedgerResult {
  entry: LedgerEntry;
  idempotentReplay: boolean;
  pausedNow: boolean;
  resumedNow: boolean;
  lowBalanceCrossed: boolean;
  balanceUsd: string;
}

/** Lazily create a tenant's wallet with defaults. Idempotent. */
export async function ensureWallet(tenantId: string): Promise<void> {
  await db.insert(tenantWallets).values({ tenantId }).onConflictDoNothing();
}

/**
 * Apply a single ledger entry atomically: lock the wallet row, add the signed
 * amount (in SQL, so decimal precision is exact), evaluate the pause/low-balance
 * state machine, then append the ledger row with the resulting balance snapshot.
 * Idempotent on (tenantId, reference): a duplicate reference — whether caught by
 * the pre-check or the unique index under a race — returns the existing entry
 * with `idempotentReplay: true` and leaves the balance untouched.
 */
export async function applyLedgerEntry(input: ApplyLedgerInput): Promise<LedgerResult> {
  await ensureWallet(input.tenantId);

  try {
    const result = await db.transaction(async (tx) => {
      // Fast-path idempotency: already recorded → no balance change.
      const [existing] = await tx
        .select()
        .from(ledgerEntries)
        .where(and(
          eq(ledgerEntries.tenantId, input.tenantId),
          eq(ledgerEntries.reference, input.reference),
        ))
        .limit(1);
      if (existing) {
        return { entry: existing, idempotentReplay: true, pausedNow: false, resumedNow: false, lowBalanceCrossed: false, balanceUsd: existing.balanceAfterUsd };
      }

      // Lock the wallet row and read prior state for the state machine.
      const [prior] = await tx
        .select()
        .from(tenantWallets)
        .where(eq(tenantWallets.tenantId, input.tenantId))
        .for('update')
        .limit(1);
      if (!prior) throw new Error(`wallet missing after ensureWallet: ${input.tenantId}`);

      // Exact decimal balance mutation in SQL.
      const [updated] = await tx
        .update(tenantWallets)
        .set({ balanceUsd: sql`${tenantWallets.balanceUsd} + ${input.amountUsd}::numeric`, updatedAt: new Date() })
        .where(eq(tenantWallets.tenantId, input.tenantId))
        .returning({ balanceUsd: tenantWallets.balanceUsd });
      const newBalance = updated.balanceUsd;

      const { stateChanges, flags } = evaluateStateMachine(prior, Number(newBalance));
      if (Object.keys(stateChanges).length > 0) {
        await tx.update(tenantWallets).set(stateChanges).where(eq(tenantWallets.tenantId, input.tenantId));
      }

      const [entry] = await tx
        .insert(ledgerEntries)
        .values({
          tenantId: input.tenantId,
          type: input.type,
          amountUsd: input.amountUsd,
          balanceAfterUsd: newBalance,
          reference: input.reference,
          description: input.description ?? null,
          metadata: input.metadata ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();

      return { entry, idempotentReplay: false, balanceUsd: newBalance, ...flags };
    });

    if (!result.idempotentReplay) {
      // Balance/pause state may have changed — drop the soft-pause cache.
      await clearPausedCache(input.tenantId);
    }
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the race to another writer with the same reference — return theirs.
      const [existing] = await db
        .select()
        .from(ledgerEntries)
        .where(and(
          eq(ledgerEntries.tenantId, input.tenantId),
          eq(ledgerEntries.reference, input.reference),
        ))
        .limit(1);
      if (existing) {
        return { entry: existing, idempotentReplay: true, pausedNow: false, resumedNow: false, lowBalanceCrossed: false, balanceUsd: existing.balanceAfterUsd };
      }
    }
    throw err;
  }
}

interface StateEval {
  stateChanges: Partial<Wallet>;
  flags: { pausedNow: boolean; resumedNow: boolean; lowBalanceCrossed: boolean };
}

/**
 * Prepaid-only pause/low-balance transitions. Auto-pause at balance <= 0 sets
 * `auto_balance`; a credit lifting balance > 0 auto-resumes ONLY an auto_balance
 * pause (a manual super-admin pause survives). Low-balance is episode-scoped:
 * crossing below the threshold stamps `lowBalanceNotifiedAt`; recovering above
 * it clears the stamp so the next drop alerts again.
 */
function evaluateStateMachine(prior: Wallet, newBalance: number): StateEval {
  const stateChanges: Partial<Wallet> = {};
  const flags = { pausedNow: false, resumedNow: false, lowBalanceCrossed: false };

  if (prior.billingMode !== 'prepaid') return { stateChanges, flags };

  const threshold = Number(prior.lowBalanceThresholdUsd);

  if (newBalance <= 0 && !prior.isPaused) {
    stateChanges.isPaused = true;
    stateChanges.pausedReason = 'auto_balance';
    stateChanges.pausedAt = new Date();
    flags.pausedNow = true;
  } else if (newBalance > 0 && prior.isPaused && prior.pausedReason === 'auto_balance') {
    stateChanges.isPaused = false;
    stateChanges.pausedReason = null;
    stateChanges.pausedAt = null;
    flags.resumedNow = true;
  }

  if (newBalance < threshold && prior.lowBalanceNotifiedAt == null) {
    stateChanges.lowBalanceNotifiedAt = new Date();
    flags.lowBalanceCrossed = true;
  } else if (newBalance >= threshold && prior.lowBalanceNotifiedAt != null) {
    stateChanges.lowBalanceNotifiedAt = null; // recovered → episode ends
  }

  return { stateChanges, flags };
}

/** Current stored wallet balance (creates the wallet if absent). */
export async function getBalance(tenantId: string): Promise<number> {
  await ensureWallet(tenantId);
  const [wallet] = await db
    .select({ balanceUsd: tenantWallets.balanceUsd })
    .from(tenantWallets)
    .where(eq(tenantWallets.tenantId, tenantId))
    .limit(1);
  return Number(wallet?.balanceUsd ?? 0);
}

/**
 * Reconciliation guard: the stored wallet balance must equal the signed sum of
 * its ledger. Logs a structured warning on drift; returns both numbers.
 */
export async function verifyBalance(tenantId: string): Promise<{ stored: number; derived: number; drift: number }> {
  const [wallet] = await db
    .select({ balanceUsd: tenantWallets.balanceUsd })
    .from(tenantWallets)
    .where(eq(tenantWallets.tenantId, tenantId))
    .limit(1);
  const [led] = await db
    .select({ sum: sql<string>`coalesce(sum(amount_usd), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.tenantId, tenantId));

  const stored = Number(wallet?.balanceUsd ?? 0);
  const derived = Number(led?.sum ?? 0);
  const drift = Math.round((stored - derived) * 1e6) / 1e6;
  if (Math.abs(drift) > 0.000001) {
    log.warn({ tenantId, stored, derived, drift }, 'Wallet balance drift vs ledger sum');
  }
  return { stored, derived, drift };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err != null && 'code' in err && (err as { code?: string }).code === '23505';
}
