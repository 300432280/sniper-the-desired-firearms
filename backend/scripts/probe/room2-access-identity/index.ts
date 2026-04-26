// backend/scripts/probe/room2-access-identity/index.ts
// Room 2: Access & Identity. Composes canonical-host + heavy WAF probe + WAF
// classification + platform detection into a single AccessIdentityState. Per spec §4.2.
//
// Pipeline:
//   1. Resolve canonical host (apex vs www) — fail Room 2 if neither answers cleanly.
//   2. Run 8-batch heavy WAF probe against canonical origin.
//   3. Classify WAF vendor from probe batches.
//   4. Pick UA based on wafType (sgcaptcha/sucuri/incapsula → iPhone, else desktop).
//   5. Fetch homepage with WAF-aware fetch (auto-escalates to Playwright when hasWaf=true).
//   6. If clean fetch fails (status >= 400) without WAF, walk UA_LADDER as escalation.
//   7. Run platform-detect on the post-challenge HTML.
//   8. If no detector matches → fail Room 2.
//   9. Assemble and return AccessIdentityState (single platformMarker winner).

import { resolveCanonicalHost } from './canonical-host';
import { runHeavyWafProbe } from './waf-heavy-probe';
import { classifyWaf } from './waf-detect';
import { detectPlatform } from './platform-detect';
import { fetchUrl } from '../shared/fetch';
import { UA_LADDER, pickUaForWaf, UA_DESKTOP, UA_IPHONE } from '../shared/ua';
import type { IntakeState, AccessIdentityState, RoomFailure } from '../shared/types';

export async function runRoom2(prev: IntakeState): Promise<AccessIdentityState | RoomFailure> {
  // 1. Canonical host
  const ch = await resolveCanonicalHost(prev.canonicalUrl);
  if (!ch.primaryResponded && !ch.wwwFallbackUsed) {
    return fail(`No response from ${prev.canonicalUrl} or www-fallback`, { ch });
  }
  const origin = ch.canonicalOrigin;

  // 2. Heavy WAF probe + classification
  const probe = await runHeavyWafProbe(`${origin}/`);
  const waf = classifyWaf(probe.batches);

  // 3. Platform detection — fetch homepage with WAF-aware fetch (auto-escalates to
  // Playwright when hasWaf=true, picks UA matching cached cookies for Mistake 30 Fix B).
  const accessUa = pickUaForWaf(waf.wafType);
  let accessFetch = await fetchUrl(`${origin}/`, {
    ua: accessUa,
    hasWaf: waf.hasWaf,
    wafType: waf.wafType,
    timeoutMs: 60000,
  });

  // If clean fetch failed and we don't have a known WAF to drive Playwright escalation,
  // walk the UA ladder. (When hasWaf=true the fetch already routed through Playwright.)
  if (accessFetch.status >= 400 && !waf.hasWaf) {
    for (const step of UA_LADDER.slice(1)) {
      try {
        const r = await fetchUrl(`${origin}/`, {
          ua: step.ua,
          forcePlaywright: step.usePlaywright,
          timeoutMs: 60000,
        });
        if (r.status < 400 && r.bodyBytes > 5000) {
          accessFetch = r;
          break;
        }
      } catch { /* try next step */ }
    }
  }

  // Parse multi-cookie set-cookie header. Node folds multiple Set-Cookie headers
  // into a comma-separated string — split on `, ` followed by `key=` to avoid
  // splitting inside Expires=Wed, 21 Oct... date attributes.
  const setCookieRaw = accessFetch.headers['set-cookie'] ?? '';
  const cookies = setCookieRaw
    ? setCookieRaw.split(/,\s*(?=[^=;,\s]+=)/).map(s => s.trim())
    : [];

  const platform = await detectPlatform({
    url: `${origin}/`,
    html: accessFetch.body,
    headers: accessFetch.headers,
    cookies,
  });
  if (!platform) {
    return fail('No platform detector matched', {
      html_bytes: accessFetch.bodyBytes,
      status: accessFetch.status,
      wafType: waf.wafType,
    });
  }

  // 4. Pick the access method that worked (or that WAF state forces).
  // Sucuri/Incapsula/SGCaptcha/CF-active all need post-challenge cookies → playwright-iphone-cookies.
  let accessMethod: AccessIdentityState['accessMethod'] = 'axios-desktop';
  if (accessUa === UA_IPHONE) accessMethod = 'axios-iphone';
  if (
    waf.wafType === 'sgcaptcha' ||
    waf.wafType === 'incapsula' ||
    waf.wafType === 'sucuri' ||
    waf.wafType === 'cloudflare-active'
  ) {
    accessMethod = 'playwright-iphone-cookies';
  }

  return {
    ...prev,
    canonicalOrigin: origin,
    canonicalOriginResolution: ch,
    hasWaf: waf.hasWaf,
    wafType: waf.wafType,
    wafProbeEvidence: {
      method: 'heavy-8-batch',
      timestamp: new Date().toISOString(),
      batches: probe.batches,
      ...waf.evidenceFlags,
    },
    needsPlaywright: accessMethod.startsWith('playwright'),
    userAgentOverride: accessUa === UA_DESKTOP ? null : accessUa,
    accessMethod,
    platform: platform.detectorId,
    platformMarker: platform,
  };
}

function fail(reason: string, evidence: Record<string, unknown>): RoomFailure {
  return {
    roomFailed: true,
    roomNumber: 2,
    reason,
    evidence,
    timestamp: new Date().toISOString(),
  };
}
