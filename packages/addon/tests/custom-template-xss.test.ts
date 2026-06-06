import { describe, expect, it } from 'vitest';
import landingTemplate from '../src/custom-template';
import type { Manifest } from '@stremio-addon/sdk';

// Uses the REAL i18n module (no mocks) so the template's sanitization boundary
// is exercised end-to-end.
function manifestWithUiLangDefault(def: string): Manifest {
  return {
    id: 'org.test.addon',
    name: 'Test Addon',
    description: 'Test',
    version: '1.0.0',
    resources: [],
    types: [],
    catalogs: [],
    config: [
      {
        key: 'uiLanguage',
        type: 'select',
        title: 'UI Language',
        default: def,
        options: ['eng', 'ger'] as unknown as string[],
      },
    ],
  } as unknown as Manifest;
}

describe('custom template — configure page XSS hardening', () => {
  it('does not reflect a script-breakout payload from the uiLanguage default', () => {
    const payload = '"></script><script>alert(document.cookie)</script>';
    const html = landingTemplate(manifestWithUiLangDefault(payload));

    // The raw breakout must never appear verbatim in the rendered page.
    expect(html).not.toContain('<script>alert(document.cookie)</script>');
    expect(html).not.toContain(payload);
  });

  it('emits a safe known language code in the inline script for a bogus default', () => {
    const html = landingTemplate(manifestWithUiLangDefault('zzz-not-a-lang'));
    expect(html).toContain('const currentLanguage = "eng"');
  });

  it('preserves a valid language code', () => {
    const html = landingTemplate(manifestWithUiLangDefault('ger'));
    expect(html).toContain('const currentLanguage = "ger"');
  });
});
