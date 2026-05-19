// backend/src/services/__test__/product-verifier.test.ts
//
// Fix 1: soldDetection regex over-matches — `class="[^"]*\bsold\b[^"]*"` matched
//        BOTH `class="sold Yes"` AND `class="sold No"` on gunpost.ca, marking
//        every alive listing as sold.
// Fix 2: wantedDetection array → regex coercion — `new RegExp(["^a","b$"], 'i')`
//        produces /^a,b$/i (comma-joined via Array.toString), which matches nothing.
//
// These tests target the two narrow helpers extracted from product-verifier.ts:
//   - matchesSoldClassPattern(html, classPattern)
//   - buildWantedRegex(pattern)
import { describe, it, expect } from 'vitest';
import {
  matchesSoldClassPattern,
  buildWantedRegex,
} from '../product-verifier';

describe('matchesSoldClassPattern (Fix 1)', () => {
  it('returns true for the explicit "sold Yes" form used by gunpost.ca', () => {
    const html = '<div class="field-sold Yes">SOLD</div>';
    expect(matchesSoldClassPattern(html, 'field-sold Yes')).toBe(true);
  });

  it('returns false for `field-sold No` (the alive case that was over-matched)', () => {
    const html = '<div class="field-sold No">For sale</div>';
    expect(matchesSoldClassPattern(html, 'field-sold Yes')).toBe(false);
  });

  it('returns false when the class is absent entirely', () => {
    const html = '<div class="card">No sold class at all</div>';
    expect(matchesSoldClassPattern(html, 'field-sold Yes')).toBe(false);
  });

  it('matches when there are extra classes around the marker', () => {
    const html = '<div class="extra-cls field-sold Yes mb-2">SOLD</div>';
    expect(matchesSoldClassPattern(html, 'field-sold Yes')).toBe(true);
  });
});

describe('buildWantedRegex (Fix 2)', () => {
  it('joins an array of patterns with | so each alternation matches', () => {
    const rx = buildWantedRegex(['^wanted', 'wtb$', 'wtt$', 'iso$']);
    expect(rx.test('wanted to buy')).toBe(true);
    expect(rx.test('looking for: wtb')).toBe(true);
    expect(rx.test('random title')).toBe(false);
  });

  it('still accepts a single string pattern (back-compat)', () => {
    const rx = buildWantedRegex('^wanted');
    expect(rx.test('wanted: scope')).toBe(true);
    expect(rx.test('selling: scope')).toBe(false);
  });

  it('returns the default regex when given undefined', () => {
    const rx = buildWantedRegex(undefined);
    // Default keeps the historical /\b(wanted|wtb|wtt|iso)\s*$/ shape
    expect(rx.test('rifle stock wanted')).toBe(true);
    expect(rx.test('shooting clinic')).toBe(false);
  });
});
