import { describe, expect, it } from 'vitest';

// Every visible string must come from the dictionaries; only these files may contain Arabic text.
// lib/format.ts keeps the legacy Arabic `pluralAr`/`PLURALS` exports for compatibility.
const ALLOWED = /^\.\.\/src\/(i18n\/messages\/[^/]+\.ts|lib\/format\.ts)$/;
const ARABIC = /[؀-ۿ]/;

const sources = import.meta.glob<string>('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });

describe('source hygiene', () => {
  it('scans the dashboard sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it('has no hard-coded Arabic UI text outside the dictionaries', () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      if (ALLOWED.test(path)) continue;
      text.split('\n').forEach((line, i) => {
        if (ARABIC.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
