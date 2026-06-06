/**
 * Creates a Basic Authentication header value.
 * Uses UTF-8 base64 (not btoa, which only handles Latin1 and would mojibake or
 * throw on non-ASCII credentials, silently breaking authentication).
 */
export function createBasic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}
