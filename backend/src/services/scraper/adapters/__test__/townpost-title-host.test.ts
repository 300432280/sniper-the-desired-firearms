// backend/src/services/scraper/adapters/__test__/townpost-title-host.test.ts
//
// Fix 2 (2026-06-05): TownPost (classifieds) data-quality.
//  (a) Title price-strip: when a card's title falls back to the whole anchor's
//      concatenated text (older markup with no data-testid="ad-title"), it became
//      `$<price><title>categories:<cats><town><time-ago>` — e.g.
//      "$1200.00Steiner GS3 ...categories:Sporting GoodsGunsToronto, ON1 day ago".
//      extractTitle() strips the sr-only `categories:` tail + leading `$<price>`
//      ONLY when BOTH a leading price AND a `categories:` marker are present
//      (the TownPost concatenated-fallback shape). This spares retail titles that
//      merely contain "categories:" (no leading price); a contrived title that has
//      both signatures could still be over-stripped, but no live fleet title does.
//  (c) Host normalization: classifieds product URLs have `www.` stripped to match
//      the canonical bare host — ONLY for sites whose canonical IS the bare host
//      (siteProfile.canonicalHost, or the known-bare allowlist). www-canonical
//      classifieds sites are left untouched so their URLs still resolve.
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { GenericAdapter } from '../generic';

// Expose the protected extractTitle for a focused unit test.
class TestAdapter extends GenericAdapter {
  public title(el: cheerio.Cheerio<any>, fallback: string): string {
    return (this as any).extractTitle(el, fallback);
  }
}

describe('TownPost classifieds — title price-strip', () => {
  const adapter = new TestAdapter();

  const cases: Array<{ raw: string; expected: string }> = [
    {
      raw: '$1200.00Steiner GS3 Game Sensing Rifle Scope 2-10x42mm.categories:Sporting GoodsGunsToronto, ON1 day ago',
      expected: 'Steiner GS3 Game Sensing Rifle Scope 2-10x42mm.',
    },
    {
      raw: '$950.00Russian SKS 7.62x39categories:Sporting GoodsGunsToronto, ON1 day ago',
      expected: 'Russian SKS 7.62x39',
    },
    {
      raw: '$120Old style Remington 700 - 742 - 760 -7400 -7600 rear sightcategories:Sporting GoodsGunsCalgary, AB1 day ago',
      expected: 'Old style Remington 700 - 742 - 760 -7400 -7600 rear sight',
    },
  ];

  for (const { raw, expected } of cases) {
    it(`strips price + categories tail from: ${raw.slice(0, 30)}…`, () => {
      const $ = cheerio.load('<div></div>');
      const el = $('div');
      expect(adapter.title(el, raw)).toBe(expected);
    });
  }

  it('does NOT alter a clean title (no categories marker)', () => {
    const $ = cheerio.load('<div></div>');
    const el = $('div');
    expect(adapter.title(el, 'Tikka T3X 270 WSM Stainless Bolt-Action Rifle')).toBe(
      'Tikka T3X 270 WSM Stainless Bolt-Action Rifle',
    );
  });

  it('does NOT strip a leading $ token when there is no categories marker', () => {
    const $ = cheerio.load('<div></div>');
    const el = $('div');
    expect(adapter.title(el, '$100 Bill Display Frame Collectible')).toBe('$100 Bill Display Frame Collectible');
  });

  // Adversarial retail titles that DO contain "categories:" but have NO leading
  // price. The tightened gate (FIX A) requires BOTH signatures, so these are kept.
  it('does NOT truncate a retail title containing "categories:" without a leading price (case 1)', () => {
    const $ = cheerio.load('<div></div>');
    const el = $('div');
    expect(adapter.title(el, 'Browse all categories: rifles, shotguns')).toBe(
      'Browse all categories: rifles, shotguns',
    );
  });

  it('does NOT truncate a retail title containing "categories:" without a leading price (case 2)', () => {
    const $ = cheerio.load('<div></div>');
    const el = $('div');
    expect(adapter.title(el, 'FDE Lower Receiver - categories: Rifle Parts')).toBe(
      'FDE Lower Receiver - categories: Rifle Parts',
    );
  });
});

describe('TownPost classifieds — host normalization', () => {
  const adapter = new GenericAdapter();

  it('_stripWww normalizes the host and preserves path/query', () => {
    const strip = (u: string) => (adapter as any)._stripWww(u);
    expect(strip('https://www.townpost.ca/marketplace/toronto/guns/x/123')).toBe(
      'https://townpost.ca/marketplace/toronto/guns/x/123',
    );
    expect(strip('https://townpost.ca/marketplace/x/1')).toBe('https://townpost.ca/marketplace/x/1');
    expect(strip('not a url')).toBe('not a url');
  });

  // FIX B: _normalizeClassifiedHost only strips www for bare-canonical sites.
  const norm = (u: string, base: string) => (adapter as any)._normalizeClassifiedHost(u, base);

  it('strips www for townpost.ca (known bare-canonical host)', () => {
    expect(
      norm(
        'https://www.townpost.ca/marketplace/toronto/guns/x/123',
        'https://www.townpost.ca/category/guns',
      ),
    ).toBe('https://townpost.ca/marketplace/toronto/guns/x/123');
  });

  it('does NOT strip www for an unknown classifieds host (could be www-canonical)', () => {
    // No siteProfile.canonicalHost in the unit cache and not on the allowlist →
    // host is left untouched so a www-canonical site keeps resolving URLs.
    expect(
      norm(
        'https://www.someclassifieds.com/marketplace/x/1',
        'https://www.someclassifieds.com/category/guns',
      ),
    ).toBe('https://www.someclassifieds.com/marketplace/x/1');
  });
});
