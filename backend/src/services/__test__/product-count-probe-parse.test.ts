// backend/src/services/__test__/product-count-probe-parse.test.ts
//
// C1: parseInt truncation on comma-bearing totals.
//   `parseInt("2,384", 10) === 2` — silently broke canadasgunstore (real 2384, recorded 2).
//   Fix uses `.replace(/,/g, '')` before parseInt so "2,384 found" becomes 2384.
//   `perPage=1` is the canonical shape for selectors whose regex extracts the TOTAL
//   directly (e.g. `of\s+(\d+)` against "Results 1 - 40 of 2452").
import { describe, it, expect } from 'vitest';
import { parseHtmlPaginationCount } from '../product-count-probe';

describe('parseHtmlPaginationCount (C1)', () => {
  it('parses "2,384 found" → 2384 (comma stripped, perPage=1)', () => {
    expect(parseHtmlPaginationCount('2,384 found', '(\\d[\\d,]*)', 1)).toBe(2384);
  });

  it('still parses "100 found" → 100 (no-comma case unchanged)', () => {
    expect(parseHtmlPaginationCount('100 found', '(\\d+)', 1)).toBe(100);
  });

  it('parses "Results 1 - 40 of 2,452" → 2452 via of-pattern', () => {
    expect(parseHtmlPaginationCount('Results 1 - 40 of 2,452', 'of\\s+(\\d[\\d,]*)', 1)).toBe(2452);
  });

  it('multiplies by perPage when regex extracts a page count', () => {
    // last-page link text "47" with perPage=24 → 47*24=1128
    expect(parseHtmlPaginationCount('47', '(\\d+)', 24)).toBe(1128);
  });

  it('returns null when no number matches', () => {
    expect(parseHtmlPaginationCount('no products here', '(\\d+)', 1)).toBeNull();
  });

  it('returns null on bad regex', () => {
    expect(parseHtmlPaginationCount('123', '(unclosed', 1)).toBeNull();
  });
});
