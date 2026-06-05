// backend/src/services/scraper/cf-interstitial.ts
//
// Pure Cloudflare-interstitial classifier (FIX 3). Passive-CF sites embed the
// `challenge-platform` beacon (cdn-cgi/challenge-platform/...) on EVERY page,
// not just block pages. Keying detection or "resolved?" on that beacon makes
// resolution never succeed on those sites → empty/challenge HTML → 0 products.
//
// These markers ONLY appear on a real interstitial (the "Just a moment..."
// block page), so we use them as the positive signal. Extracted as a pure
// module so it can be unit-tested and shared by the Node-side detection and the
// in-browser resolution predicate in playwright-fetcher.ts.

/**
 * True when the HTML is a genuine Cloudflare interstitial / block page (NOT a
 * normal page that merely loads the challenge-platform beacon).
 */
export function isCfInterstitial(html: string): boolean {
  return (
    html.includes('cf-browser-verification') ||
    html.includes('Just a moment...') ||
    html.includes('Checking your browser') ||
    html.includes('cf-challenge') ||
    html.includes('cf-chl-') ||
    html.includes('_cf_chl_opt') ||
    html.includes('_cf_chl') ||
    html.includes('challenges.cloudflare.com/turnstile') ||
    html.includes('Attention Required') ||
    html.includes('Verifying you are human') ||
    // Minimal CF block pages: tiny HTML mentioning cloudflare.
    (html.length < 5000 && html.includes('cloudflare'))
  );
}

/**
 * True when an interstitial has resolved to real content. Mirrors the in-browser
 * predicate used by page.waitForFunction in playwright-fetcher.ts: interstitial
 * text/markers gone AND a substantial body present. Deliberately does NOT key on
 * `challenge-platform` (present on every passive-CF page).
 *
 * NOTE: the inline page.waitForFunction predicate in playwright-fetcher.ts is the
 * AUTHORITATIVE resolution check (it runs in the browser, against the live DOM).
 * This function mirrors that logic only so the contract can be unit-tested.
 */
export function isCfResolved(html: string): boolean {
  if (
    html.includes('Just a moment') ||
    html.includes('Checking your browser') ||
    html.includes('Verifying you are human') ||
    html.includes('Attention Required') ||
    html.includes('_cf_chl_opt') ||
    html.includes('challenges.cloudflare.com/turnstile') ||
    html.includes('id="cf-browser-verification"') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-form"')
  ) {
    return false;
  }
  return html.length > 5000;
}
