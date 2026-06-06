import { describe, it, expect } from 'vitest';
import { createBasic } from '../src/utils';

// The Basic auth header must base64-encode the UTF-8 bytes of "user:pass".
// `btoa` only handles Latin1: it mojibakes accented chars (≤0xFF) and throws on
// anything above 0xFF, so credentials with non-ASCII characters silently fail
// authentication (or crash the search). createBasic must be UTF-8 safe.
const expected = (u: string, p: string) =>
  `Basic ${Buffer.from(`${u}:${p}`, 'utf-8').toString('base64')}`;

describe('createBasic', () => {
  it('encodes plain ASCII credentials', () => {
    expect(createBasic('user', 'pass')).toBe(expected('user', 'pass'));
  });

  it('encodes Latin1-range accented characters as UTF-8 (not mojibake)', () => {
    expect(createBasic('üser', 'pä$$wörd')).toBe(expected('üser', 'pä$$wörd'));
  });

  it('handles characters above the Latin1 range without throwing', () => {
    expect(() => createBasic('zloty', 'pa€sł')).not.toThrow();
    expect(createBasic('zloty', 'pa€sł')).toBe(expected('zloty', 'pa€sł'));
  });
});
