// backend/src/services/__test__/keyword-matcher-proximity-2026-05-27.test.ts
//
// Multi-word AND matching must respect a token-proximity window.
//
// Regression: the SKS alias group contains "type 56" (Chinese Type 56 is an
// SKS clone). The old matcher accepted "type 56" against
// "NORINCO TYPE 97 NSR G3 .223/5.56 18.6 ..." because "type" (from TYPE 97)
// and "56" (from the 5.56 caliber) each appear in the title, far apart and
// in unrelated positions. The proximity window rejects scattered hits while
// keeping legitimate brand+spec matches like "mauser 308".
import { describe, it, expect } from 'vitest';
import { matchesKeyword, matchesWithExtras } from '../keyword-matcher';

const NORINCO_TYPE_97 = 'NORINCO TYPE 97 NSR G3 .223/5.56 18.6 BA F-NOR-TYPE97NSR-G3';

describe('multi-word AND proximity (2026-05-27 westernmetal false positive)', () => {
  it('does NOT match "type 56" against the Norinco Type 97 title', () => {
    expect(matchesKeyword(NORINCO_TYPE_97, 'type 56')).toBe(false);
    // and through the real call path (title + tags + urlSlug combined)
    expect(
      matchesWithExtras(NORINCO_TYPE_97, 'type 56', { tags: 'Rifles - Non Restricted', urlSlug: '' }),
    ).toBe(false);
  });

  it('still matches "type 56" when the words are actually adjacent', () => {
    expect(matchesKeyword('Norinco Type 56 SKS 7.62x39 Rifle', 'type 56')).toBe(true);
  });

  it('keeps "mauser 308" -> "Mauser K98 .308 Win" (1 filler token)', () => {
    expect(matchesKeyword('Mauser K98 .308 Win Rifle', 'mauser 308')).toBe(true);
  });

  it('keeps 3-word "savage axis 308" -> "Savage Axis II .308 Win"', () => {
    expect(matchesKeyword('Savage Axis II .308 Win', 'savage axis 308')).toBe(true);
  });

  it('keeps "glock 19" -> "Glock 19X Gen5" (variant naming, right-unbounded)', () => {
    expect(matchesKeyword('Glock 19X Gen5 9mm', 'glock 19')).toBe(true);
  });

  it('rejects "mauser 308" when brand and caliber are far apart', () => {
    // brand ... 4 filler tokens ... caliber: scattered, should not match
    expect(matchesKeyword('Mauser Model 98 Sporter Custom Deluxe .308', 'mauser 308')).toBe(false);
  });

  it('single-word "sks" is unaffected: matches a real SKS, not the Type 97', () => {
    expect(matchesKeyword('Russian SKS 7.62x39 Rifle', 'sks')).toBe(true);
    expect(matchesKeyword(NORINCO_TYPE_97, 'sks')).toBe(false);
  });
});
