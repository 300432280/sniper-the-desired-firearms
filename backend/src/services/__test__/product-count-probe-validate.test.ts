// backend/src/services/__test__/product-count-probe-validate.test.ts
//
// Fix 4: schema validator for ProductCountMethod.
//
// Previously, an unknown / drifted `method` value (e.g. 'dual-api', a typo,
// or a profile field nobody updated when methods were renamed) hit the
// switch's `default` branch and returned null silently. The new
// `validateMethod` function rejects unknown methods upfront with a clear
// error message naming the offending value.
import { describe, it, expect } from 'vitest';
import { validateMethod, VALID_METHOD_NAMES } from '../product-count-probe';

describe('validateMethod (Fix 4)', () => {
  it('throws on unknown method names', () => {
    expect(() => validateMethod({ method: 'dual-api' } as any))
      .toThrow(/unknown product-count method.*dual-api/i);
  });

  it('throws when method field is missing entirely', () => {
    expect(() => validateMethod({} as any))
      .toThrow(/unknown product-count method/i);
  });

  it('does not throw for any of the 11 canonical method names', () => {
    for (const name of VALID_METHOD_NAMES) {
      expect(() => validateMethod({ method: name } as any)).not.toThrow();
    }
  });

  it('exposes exactly the 11 canonical method names', () => {
    expect(VALID_METHOD_NAMES.slice().sort()).toEqual([
      'ecwid-storefront-search',
      'generic-product-sitemap',
      'html-pagination',
      'json-api-count',
      'json-api-length',
      'klevu-api-count',
      'shopify-products-walk',
      'sitemap',
      'sitemap-index',
      'stream-page-count',
      'wp-rest-header',
    ]);
  });
});
