/**
 * Money helpers. All billing math stays in decimal-as-string form at the DB
 * boundary; these helpers exist for the few places we must compute in JS
 * (margin application, invoice totals). Rounding is half-away-from-zero so a
 * negative debit rounds symmetrically to a positive credit of the same size.
 */

export function roundHalfUp(value: number, dp: number): number {
  const factor = 10 ** dp;
  const sign = value < 0 ? -1 : 1;
  // toPrecision(15) collapses the binary-representation error (e.g. 1.005*100 =
  // 100.49999999999999 → "100.500000000000") so a genuine half rounds up. A
  // fixed Number.EPSILON nudge is too small to correct the error at this scale.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (sign * Math.round(scaled)) / factor;
}

/** Format a number as a fixed-precision decimal string for a decimal column. */
export function toUsd(value: number, dp = 6): string {
  return roundHalfUp(value, dp).toFixed(dp);
}

/** Apply a percentage margin to a raw cost: cost * (1 + pct/100). */
export function applyMargin(rawCost: number, marginPct: number): number {
  return rawCost * (1 + marginPct / 100);
}
