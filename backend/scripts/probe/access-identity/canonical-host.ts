// backend/scripts/probe/access-identity/canonical-host.ts
// Resolve apex vs www. Per spec §4.2 + Mistake (lockharttactical).
// Apex may serve a CF Managed Challenge while www is clean (or vice versa for
// reliablegun.com, where apex runs IIS but www is Cloudflare-fronted).

import { fetchUrl } from '../shared/fetch';

const CHALLENGE_BODY_MARKERS = [
  /Just a moment\.\.\./i,
  /_cf_chl_opt/,
  /sucuri_cloudproxy_js/,
  /<meta\s+http-equiv="refresh"\s+content="\d+;\s*\/\.well-known\/sgcaptcha\//i,
  /Incapsula incident ID/i,
  /cf-mitigated:\s*challenge/i,
  /MalCare WordPress Security Plugin/i,
];

export function hasChallengeMarkers(body: string): boolean {
  // Real challenge bodies are tiny (< 50KB) — anything larger is real content that happens to mention a marker
  if (body.length > 50000) return false;
  return CHALLENGE_BODY_MARKERS.some(re => re.test(body));
}

export type CanonicalHostResult = {
  canonicalOrigin: string;
  primaryResponded: boolean;        // primary = the input host (may be apex OR www)
  primaryWasChallenged: boolean;
  wwwFallbackUsed: boolean;
  serverHeaders: { primary?: string; canonical?: string };
};

export async function resolveCanonicalHost(canonicalUrl: string): Promise<CanonicalHostResult> {
  const u = new URL(canonicalUrl);
  const host = u.hostname;
  const apexHost = host.startsWith('www.') ? host.slice(4) : host;
  const wwwHost = host.startsWith('www.') ? host : `www.${host}`;
  const result: CanonicalHostResult = {
    canonicalOrigin: `${u.protocol}//${host}`,
    primaryResponded: false,
    primaryWasChallenged: false,
    wwwFallbackUsed: false,
    serverHeaders: {},
  };

  // Try the input host first
  let primary;
  try {
    primary = await fetchUrl(`${u.protocol}//${host}/`);
    result.primaryResponded = true;
    result.serverHeaders.primary = primary.headers['server'];
    const challenged = hasChallengeMarkers(primary.body);
    if (primary.status >= 400 && challenged) {
      result.primaryWasChallenged = true;
    } else if (primary.status >= 200 && primary.status < 400 && challenged) {
      // Sucuri / Incapsula often return 200 + challenge body (no HTTP-level rejection)
      result.primaryWasChallenged = true;
    } else if (primary.status >= 200 && primary.status < 400) {
      // Primary works cleanly — no www-fallback needed
      result.serverHeaders.canonical = primary.headers['server'];
      return result;
    }
  } catch {
    result.primaryResponded = false;
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
