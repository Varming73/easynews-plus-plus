import { describe, expect, it } from 'vitest';
import { sanitizeUiLanguage, DEFAULT_UI_LANGUAGE } from '../src/i18n';

describe('sanitizeUiLanguage', () => {
  it('returns a valid UI language code unchanged', () => {
    expect(sanitizeUiLanguage('eng')).toBe('eng');
    expect(sanitizeUiLanguage('ger')).toBe('ger');
    expect(sanitizeUiLanguage('bul')).toBe('bul');
  });

  it('falls back to the default for an unknown code', () => {
    expect(sanitizeUiLanguage('zzz')).toBe(DEFAULT_UI_LANGUAGE);
  });

  it('falls back to the default for an empty string', () => {
    expect(sanitizeUiLanguage('')).toBe(DEFAULT_UI_LANGUAGE);
  });

  it('falls back to the default for undefined', () => {
    expect(sanitizeUiLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE);
  });

  it('neutralizes a script-injection payload (XSS guard)', () => {
    const payload = '"></script><script>alert(1)</script>';
    expect(sanitizeUiLanguage(payload)).toBe(DEFAULT_UI_LANGUAGE);
  });

  it('does not treat inherited Object properties as valid codes', () => {
    // `'__proto__' in obj` is true for object literals — guard against it
    expect(sanitizeUiLanguage('__proto__')).toBe(DEFAULT_UI_LANGUAGE);
    expect(sanitizeUiLanguage('constructor')).toBe(DEFAULT_UI_LANGUAGE);
    expect(sanitizeUiLanguage('toString')).toBe(DEFAULT_UI_LANGUAGE);
  });

  it('uses "eng" as the documented default', () => {
    expect(DEFAULT_UI_LANGUAGE).toBe('eng');
  });
});
