// backend/src/services/__test__/keyword-matcher-short-alias-boundary-2026-06-01.test.ts
//
// Short aliases get a right word boundary ONLY when they are purely
// alphabetic. The rule (isShortAlphaAlias): length <= 3 AND letters only.
//
// Regression: expandKeyword("magazine") includes the 3-char alias "mag". The
// matcher's left-only word boundary let "mag" prefix-match unrelated longer
// WORDS — "Magnum", "Magpul", "Magnet", and SKUs like "MAG526-BLK". Measured
// live on bullseyenorth: 237 of 405 "magazine" results (59%) matched ONLY via
// this "mag" prefix collision (Magpul SKUs, Magnum ammo, a Magnet, even a
// Morakniv).
//
// First fix gated on length alone (<=3), which over-blocked alphanumeric and
// symbol model-code aliases that legitimately prefix a model VARIANT and have
// no alpha fallback: "m&p" -> "M&P9", "g19" -> "G19X", "g17" -> "G17L",
// ".45" -> ".45ACP", "9mm" -> "9mm Luger". The refined rule restricts the
// right boundary to PURELY-ALPHABETIC short aliases, so those model codes keep
// right-unbounded prefix matching while "mag"/"sks"/"gun" stay token-bounded.
import { describe, it, expect } from 'vitest';
import { matchesKeyword } from '../keyword-matcher';

describe('short-alias right boundary (2026-06-01 "mag" prefix false positive)', () => {
  describe('short PURELY-ALPHA alias "mag" must NOT prefix-match longer words', () => {
    it('does NOT match "mag" against a Magpul PMAG product', () => {
      expect(matchesKeyword('Magpul PMAG 30 AR/M4 GEN M3', 'mag')).toBe(false);
    });

    it('does NOT match "mag" against ".44 Magnum"', () => {
      expect(matchesKeyword('Frankford Arsenal .44 Magnum', 'mag')).toBe(false);
    });

    it('does NOT match "mag" against "Magnet"', () => {
      expect(matchesKeyword('Lockdown Magnet', 'mag')).toBe(false);
    });

    it('does NOT match "mag" against a "MAG526-BLK" SKU (digit suffix)', () => {
      expect(matchesKeyword('MAG526-BLK Magpul Floorplate', 'mag')).toBe(false);
    });

    // BY DESIGN: "sks" is a purely-alpha short alias, so the glued model
    // variant "SKS47" is intentionally NOT matched by the bare alias. The
    // standalone "SKS Rifle" still matches via the space boundary (asserted
    // below), and "SKS-45" matches via the dedicated `sks-45` alias. This keeps
    // the FP fix simple and predictable rather than special-casing glued digits.
    it('does NOT match "sks" against glued "SKS47" (BY DESIGN — see comment)', () => {
      expect(matchesKeyword('Norinco SKS47 7.62x39 Rifle', 'sks')).toBe(false);
    });
  });

  describe('alphanumeric / symbol short model-code aliases STILL prefix-match variants', () => {
    it('matches "m&p" -> "S&W M&P9 Compact" (symbol model code)', () => {
      expect(matchesKeyword('S&W M&P9 Compact', 'm&p')).toBe(true);
    });

    it('matches "g19" -> "Glock G19X" (digit model code)', () => {
      expect(matchesKeyword('Glock G19X Gen5 9mm', 'g19')).toBe(true);
    });

    it('matches "g17" -> "Glock G17L" (digit model code)', () => {
      expect(matchesKeyword('Glock G17L Long Slide', 'g17')).toBe(true);
    });

    it('matches ".45" -> ".45ACP 230gr" (symbol/digit caliber)', () => {
      expect(matchesKeyword('Federal .45ACP 230gr FMJ', '.45')).toBe(true);
    });

    it('matches "9mm" -> "9mm Luger" (digit caliber)', () => {
      expect(matchesKeyword('Winchester 9mm Luger 115gr', '9mm')).toBe(true);
    });
  });

  describe('legit matches STILL pass', () => {
    it('matches "mag" as a standalone token "30-round mag"', () => {
      expect(matchesKeyword('30-round mag', 'mag')).toBe(true);
    });

    it('matches the real alias "magazine" against a Magpul magazine', () => {
      expect(matchesKeyword('Magpul PMAG 30 AR/M4 magazine', 'magazine')).toBe(true);
    });

    it('matches "glock" -> "Glock 19 Gen5" (standalone)', () => {
      expect(matchesKeyword('Glock 19 Gen5', 'glock')).toBe(true);
    });

    it('matches "glock" -> "Glock17" (>=4 char alias, right-unbounded model variant)', () => {
      expect(matchesKeyword('Glock17 9mm Pistol', 'glock')).toBe(true);
    });

    it('matches "ar15" -> "AR-15 Rifle" (separator-insensitive, >=4 chars)', () => {
      expect(matchesKeyword('AR-15 Rifle', 'ar15')).toBe(true);
    });

    it('matches "sks" -> "Russian SKS Rifle" (standalone 3-char token)', () => {
      expect(matchesKeyword('Russian SKS Rifle', 'sks')).toBe(true);
    });
  });
});
