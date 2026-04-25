// backend/scripts/probe/room2-access-identity/canonical-host.ts
// Resolve apex vs www. Per spec §4.2 + Mistake (lockharttactical).
// Apex may serve a CF Managed Challenge while www is clean.

import { fetchUrl } from '../shared/fetch';

const CHALLENGE_BODY_MARKERS = [
  /Just a moment\.\.\./i,
  /_cf_chl_opt/,
  /sucuri_cloudproxy_js/,
  /<meta\s+http-equiv="refresh"\s+content="\d+;\s*\/\.well-known\/sgcaptcha\//i,
  /Incapsula incident ID/i,
  /cf-mitigated:\s*challenge/i,
];

export function hasChallengeMarkers(body: string): boolean {
  // Real challenge bodies are tiny (< 50KB) — anything larger is real content that happens to mention a marker
  if (body.length > 50000) return false;
  return CHALLENGE_BODY_MARKERS.some(re => re.test(body));
}

export type CanonicalHostResult = {
  canonicalOrigin: string;
  apexResponded: boolean;
  apexWasChallenged: boolean;
  wwwFallbackUsed: boolean;
  serverHeaders: { apex?: string; canonical?: string };
};

export async function resolveCanonicalHost(canonicalUrl: string): Promise<CanonicalHostResult> {
  const u = new URL(canonicalUrl);
  const host = u.hostname;
  const apexHost = host.startsWith('www.') ? host.slice(4) : host;
  const wwwHost = host.startsWith('www.') ? host : `www.${host}`;
  const result: CanonicalHostResult = {
    canonicalOrigin: `${u.protocol}//${host}`,
    apexResponded: false,
    apexWasChallenged: false,
    wwwFallbackUsed: false,
    serverHeaders: {},
  };

  // Try the input host first
  let primary;
  try {
    primary = await fetchUrl(`${u.protocol}//${host}/`);
    result.apexResponded = true;
    result.serverHeaders.apex = primary.headers['server'];
    if (primary.status >= 400 && hasChallengeMarkers(primary.body)) {
      result.apexWasChallenged = true;
    } else if (primary.status >= 200 && primary.status < 400 && !hasChallengeMarkers(primary.body)) {
      // Primary works, no www-fallback needed
      result.serverHeaders.canonical = primary.headers['server'];
      return result;
    }
  } catch {
    result.apexResponded = false;
  }

  // www-fallback: try the OTHER form (apex → www, or www → apex)
  const fallbackHost = host.startsWith('www.') ? apexHost : wwwHost;
  if (fallbackHost === host) return result;
  try {
    const fallback = await fetchUrl(`${u.protocol}//${fallbackHost}/`);
    if (fallback.status >= 200 && fallback.status < 400 && !hasChallengeMarkers(fallback.body)) {
      result.canonicalOrigin = `${u.protocol}//${fallbackHost}`;
      result.wwwFallbackUsed = true;
      result.serverHeaders.canonical = fallback.headers['server'];
    }
  } catch { /* leave canonicalOrigin = primary */ }

  return result;
}
