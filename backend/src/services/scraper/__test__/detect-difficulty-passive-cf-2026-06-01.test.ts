// backend/src/services/scraper/__test__/detect-difficulty-passive-cf-2026-06-01.test.ts
//
// FIX A — passive Cloudflare must NOT set hasWaf. Passive-CF sites
// (jobrookoutdoors.com, solelyoutdoors.com) return HTTP 200 with full product
// HTML and a `cf-ray` header on EVERY response. Keying hasWaf on the header alone
// forced every catalog page through Playwright and made the scheduler re-latch
// hasWaf back to true (crawl-scheduler.ts:442) after the operator cleared it.
// detectDifficultySignals now flags Cloudflare only when the BODY is a genuine
// interstitial. Sucuri signals stay unconditional.
import { describe, it, expect } from 'vitest';
import { detectDifficultySignals } from '../http-client';

const realProductBody =
  '<html><head><script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script></head>' +
  '<body><div class="product-grid">' +
  Array.from({ length: 30 }, (_, i) => `<a class="product" href="/p/${i}">Rifle ${i}</a>`).join('') +
  '</div>' + 'x'.repeat(6000) + '</body></html>';

const cfInterstitialBody =
  '<html><head><title>Just a moment...</title></head>' +
  '<body><div id="challenge-running"></div><script>window._cf_chl_opt={cvId:"3"}</script></body></html>';

describe('detectDifficultySignals — passive Cloudflare (FIX A)', () => {
  it('does NOT set hasWaf for passive CF (cf-ray + 200 product HTML)', () => {
    const s = detectDifficultySignals(200, { 'cf-ray': 'abc123-YYZ' }, realProductBody);
    expect(s.hasWaf).toBe(false);
  });

  it('does NOT set hasWaf for server: cloudflare + 200 product HTML', () => {
    const s = detectDifficultySignals(200, { server: 'cloudflare' }, realProductBody);
    expect(s.hasWaf).toBe(false);
  });

  it('DOES set hasWaf when Cloudflare serves a genuine interstitial body', () => {
    const s = detectDifficultySignals(403, { 'cf-ray': 'abc123-YYZ' }, cfInterstitialBody);
    expect(s.hasWaf).toBe(true);
  });

  it('keeps Sucuri signals unconditional (header alone sets hasWaf)', () => {
    const s = detectDifficultySignals(200, { 'x-sucuri-id': '12345' }, realProductBody);
    expect(s.hasWaf).toBe(true);
  });

  it('keeps Sucuri cloudproxy body signal unconditional', () => {
    const s = detectDifficultySignals(200, {}, '<html>sucuri_cloudproxy_js challenge</html>');
    expect(s.hasWaf).toBe(true);
  });

  it('no CF, no Sucuri -> hasWaf false', () => {
    const s = detectDifficultySignals(200, { server: 'nginx' }, realProductBody);
    expect(s.hasWaf).toBe(false);
  });
});
