// backend/scripts/probe/shared/url-utils.ts
// Each NAV_KEYWORDS entry must match a full path segment (followed by /, ?, or end-of-path)
// to avoid false positives like /products/about-our-company-shotgun matching /about.
const NAV_KEYWORDS = /\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|pages?|sitemap|robots|search)(\/|\?|$)/i;
const NAV_FRAGMENTS = /^(mailto:|javascript:|tel:|sms:|#)/i;

export function canonicalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) {
    if (!s.includes('://')) s = 'https://' + s;
    else throw new Error(`Unsupported scheme: ${input}`);
  }
  let u: URL;
  try { u = new URL(s); }
  catch (err) { throw new Error(`Malformed URL: ${input}`); }
  // Reject localhost/private
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    throw new Error(`Private/localhost not allowed: ${host}`);
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = host;
  // Path case is preserved (e.g. Magento URLs are case-sensitive in some installs)
  return u.toString();
}

export function isLikelyNavUrl(url: string): boolean {
  if (NAV_FRAGMENTS.test(url)) return true;
  let path: string;
  try { path = new URL(url).pathname; } catch { return false; }
  return NAV_KEYWORDS.test(path);
}

export function stripTrailingSlash(url: string): string {
  if (url.length > 1 && url.endsWith('/') && !url.endsWith('://')) {
    // Preserve trailing slash on bare-host root
    const u = new URL(url);
    if (u.pathname === '/') return url;
    return url.replace(/\/$/, '');
  }
  return url;
}
