// src/utils/statistics.utils.ts
// Pure statistics helpers shared across analytics services.

const WILSON_Z = 1.645; // 90% confidence interval

/**
 * Wilson score lower bound — penalises high win rates from small samples.
 * Returns fraction [0, 1]; multiply by 100 for percentage.
 * A 10/10 record returns ~0.69, not 1.0.
 */
export function wilsonLowerBound(wins: number, n: number, z = WILSON_Z): number {
  if (n === 0) return 0;
  const p     = wins / n;
  const z2    = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}
