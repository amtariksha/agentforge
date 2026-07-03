/**
 * UTC period math. Billing periods are strictly UTC calendar months; usage days
 * are UTC calendar days. All boundaries are computed from Date.UTC so a server
 * in any timezone agrees on period bounds and debit reference dates.
 */

export function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function utcNextMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export function utcPrevMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 0, 0, 0, 0));
}

/** Start of the current UTC day (completed days are strictly before this). */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** 'YYYY-MM' — usage-debit reference prefix and dedupe-key month. */
export function utcMonthPrefix(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYYMM' — invoice-number month component. */
export function utcMonthCompact(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' — usage-debit reference day. */
export function utcDayString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
