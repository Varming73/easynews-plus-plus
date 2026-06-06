import { describe, it, expect } from 'vitest';
import { parseIntEnv } from '../src/env';

describe('parseIntEnv', () => {
  it('parses a valid integer string', () => {
    expect(parseIntEnv('250', 100)).toBe(250);
  });

  it('returns the fallback for undefined', () => {
    expect(parseIntEnv(undefined, 100)).toBe(100);
  });

  it('returns the fallback for an empty string', () => {
    expect(parseIntEnv('', 100)).toBe(100);
  });

  it('returns the fallback for a non-numeric value (NaN guard)', () => {
    expect(parseIntEnv('disabled', 100)).toBe(100);
  });

  it('preserves an explicit zero (not the fallback)', () => {
    expect(parseIntEnv('0', 100)).toBe(0);
  });
});
