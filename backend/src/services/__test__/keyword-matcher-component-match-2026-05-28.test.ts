// backend/src/services/__test__/keyword-matcher-component-match-2026-05-28.test.ts
//
// The multi-word AND proximity branch used matchesKeywordExact per token
// (left-boundary prefix, right-unrestricted), which caused two false positives:
//   - "type 56" matched "...5.56CAL..." because "56" matched the FRACTION of
//     the decimal caliber "5.56".
//   - "tm 22" matched "...TMJ bullet..." because the short alpha "tm"
//     prefix-matched into "TMJ".
// The fix introduces componentMatchesToken (used ONLY by wordsWithinProximity),
// which rejects decimal-fraction numeric sub-matches and short (<3) alpha
// prefixes that run into a longer token. Single-word exact/stripped/flex
// branches are unchanged.
import { describe, it, expect } from 'vitest';
import { matchesKeyword, matchesWithExtras } from '../keyword-matcher';

describe('component-match boundary fixes (2026-05-28)', () => {
  describe('false positives now REJECTED', () => {
    const NORINCO_556 = 'NORINCO TYPE97NSR 5.56CAL 18.6 DESERT VERSION';

    it('rejects "type 56" against a 5.56 caliber title (decimal fraction)', () => {
      expect(matchesKeyword(NORINCO_556, 'type 56')).toBe(false);
    });

    it('rejects "type 56" through the combined title+tags path', () => {
      expect(
        matchesWithExtras(NORINCO_556, 'type 56', { tags: 'Rifles - Non Restricted', urlSlug: '' }),
      ).toBe(false);
    });

    it('rejects "tm 22" against "...TMJ bullet..." (short-alpha prefix)', () => {
      expect(matchesKeyword('Speer 22cal (.224) 55gr TMJ bullet 100/Box', 'tm 22')).toBe(false);
    });
  });

  describe('legit matches STILL pass (regression guard)', () => {
    it('"rem 700" -> "Remington Model 700" (3-char abbrev prefix, non-contiguous)', () => {
      expect(matchesKeyword('Remington Model 700 .308', 'rem 700')).toBe(true);
    });

    it('"moss 500" -> "Mossberg 500"', () => {
      expect(matchesKeyword('Mossberg 500 12ga Pump', 'moss 500')).toBe(true);
    });

    it('"glock 19" -> "Glock 19X Gen5" (variant via EXACT branch)', () => {
      expect(matchesKeyword('Glock 19X Gen5 9mm', 'glock 19')).toBe(true);
    });

    it('"savage 64" -> "Savage 64F" (variant via EXACT branch)', () => {
      expect(matchesKeyword('Savage 64F .22LR Rifle', 'savage 64')).toBe(true);
    });

    it('"cz 75" -> "CZ 75 Shadow" (2-char alpha as clean token)', () => {
      expect(matchesKeyword('CZ 75 Shadow 2 9mm', 'cz 75')).toBe(true);
    });

    it('"mark iv" -> "Ruger Mark IV" (2-char roman as clean token)', () => {
      expect(matchesKeyword('Ruger Mark IV Target .22LR', 'mark iv')).toBe(true);
    });

    it('"type 56" -> "Norinco Type 56 SKS 7.62x39" (legit adjacent)', () => {
      expect(matchesKeyword('Norinco Type 56 SKS 7.62x39', 'type 56')).toBe(true);
    });

    it('"223 rem" -> "Tikka T3x .223 Rem" (leading decimal, not a fraction)', () => {
      expect(matchesKeyword('Tikka T3x .223 Rem Bolt Action', '223 rem')).toBe(true);
    });
  });
});
