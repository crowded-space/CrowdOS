import { describe, it, expect } from 'vitest';
import { highlightCode, languageFromHint, languageFromPath } from './code-highlight';

describe('languageFromHint', () => {
  it('resolves extension aliases through hljs', () => {
    expect(languageFromHint('ts')).toBe('ts');
    expect(languageFromHint('tsx')).toBe('tsx');
    expect(languageFromHint('py')).toBe('py');
    expect(languageFromHint('sh')).toBe('sh');
    expect(languageFromHint('yml')).toBe('yml');
    expect(languageFromHint('md')).toBe('md');
  });

  it('resolves fence labels and rejects unknown hints', () => {
    expect(languageFromHint('typescript')).toBe('typescript');
    expect(languageFromHint(' JavaScript ')).toBe('javascript');
    expect(languageFromHint('klingon')).toBeNull();
    expect(languageFromHint('')).toBeNull();
    expect(languageFromHint(null)).toBeNull();
    expect(languageFromHint(undefined)).toBeNull();
  });
});

describe('languageFromPath', () => {
  it('derives the language from the file extension', () => {
    expect(languageFromPath('src/app.tsx')).toBeTruthy();
    expect(languageFromPath('AUDIT_REPORT_2026-08-26.md')).toBeTruthy();
    expect(languageFromPath('infra/main.tf')).toBeNull();
    expect(languageFromPath('Makefile')).toBeNull();
  });
});

describe('highlightCode', () => {
  it('emits hljs token spans for known languages', () => {
    const html = highlightCode('const x = 1;', 'ts');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-number');
  });

  it('escapes html when the language is unknown', () => {
    const html = highlightCode('<script>alert(1)</script>', 'klingon');
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<span');
  });

  it('escapes html when no language is given', () => {
    expect(highlightCode('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('skips highlighting past the size guard', () => {
    const big = 'const x = 1;\n'.repeat(8000);
    expect(big.length).toBeGreaterThan(100_000);
    const html = highlightCode(big, 'ts');
    expect(html).not.toContain('<span');
    expect(html).toContain('const x = 1;');
  });
});
