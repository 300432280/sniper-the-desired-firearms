// backend/src/services/scraper/__test__/cf-interstitial.test.ts
//
// FIX 3 — Cloudflare interstitial classifier. The `challenge-platform` beacon is
// on EVERY page of a passive-CF site (jobrook/solely/gunpost/londero), so keying
// detection/resolution on it makes resolution never succeed → 0 products. The
// classifier must key only on TRUE interstitial markers, and must treat a normal
// page that merely loads the beacon as real content.
import { describe, it, expect } from 'vitest';
import { isCfInterstitial, isCfResolved } from '../cf-interstitial';

// A realistic passive-CF page: substantial product markup PLUS the beacon.
const passiveCfPage =
  '<html><head><script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script></head>' +
  '<body>' +
  '<div class="product-grid">' +
  Array.from({ length: 30 }, (_, i) => `<a class="product" href="/p/${i}">Rifle ${i}</a>`).join('') +
  '</div>' +
  '<p>'.padEnd(6000, 'x') + '</p>' +
  '</body></html>';

// A real CF interstitial block page.
const cfBlockPage =
  '<html><head><title>Just a moment...</title></head>' +
  '<body><div id="challenge-running"></div>' +
  '<script>window._cf_chl_opt={cvId:"3"}</script></body></html>';

describe('isCfInterstitial (FIX 3)', () => {
  it('returns FALSE for a normal page that merely loads the challenge-platform beacon', () => {
    expect(passiveCfPage.includes('challenge-platform')).toBe(true); // beacon present
    expect(isCfInterstitial(passiveCfPage)).toBe(false);            // but NOT a challenge
  });

  it('returns TRUE for a real "Just a moment..." block page', () => {
    expect(isCfInterstitial(cfBlockPage)).toBe(true);
  });

  it('returns TRUE for a turnstile / _cf_chl_opt interstitial', () => {
    const html = '<html><body><script>_cf_chl_opt</script><iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe></body></html>';
    expect(isCfInterstitial(html)).toBe(true);
  });

  it('returns TRUE for a tiny cloudflare shell', () => {
    expect(isCfInterstitial('<html><body>cloudflare</body></html>')).toBe(true);
  });

  it('returns FALSE for ordinary product HTML with no CF markers at all', () => {
    expect(isCfInterstitial('<html><body><div class="product">Glock 19</div></body></html>')).toBe(false);
  });
});

describe('isCfResolved (FIX 3)', () => {
  it('reports a passive-CF page (beacon present, real content) as RESOLVED', () => {
    // This is the core regression: previously requiring !challenge-platform meant
    // resolution NEVER succeeded on passive-CF sites.
    expect(isCfResolved(passiveCfPage)).toBe(true);
  });

  it('reports a still-showing interstitial as NOT resolved', () => {
    expect(isCfResolved(cfBlockPage)).toBe(false);
  });

  it('reports an empty shell (no interstitial markers but tiny body) as NOT resolved', () => {
    expect(isCfResolved('<html><body></body></html>')).toBe(false);
  });
});
