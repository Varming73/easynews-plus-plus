/**
 * Parse an integer environment variable, returning `fallback` when the value is
 * undefined, empty, or not a number. Guards against the silent `NaN` that a bare
 * `parseInt(process.env.X)` produces for malformed values — `NaN` comparisons
 * are always false, which would disable limits rather than fall back to a default.
 */
export function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
