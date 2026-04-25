// backend/scripts/probe/room2-access-identity/waf-detect.ts
// Vendor classification from heavy-probe batches. Cherry-picked from probe-access.ts.
// Rules:
//   - Active CF requires browser-UA challenge (curl/bot 403 from Bot Fight Mode is passive, not active)
//   - Origin rules (mod_security/Wordfence) blocking SQLi/XSS without vendor headers ≠ WAF
//   - Consistency guard: wafType != null → hasWaf = true
// Reference: spec §4.2, .claude/probe-rewrite-lessons.md §2

import type { HeavyProbeBatchResult, WafType, AccessIdentityState } from '../shared/types';

type WafEvidence = AccessIdentityState['wafProbeEvidence'];

export type WafClassification = {
  hasWaf: boolean;
  wafType: WafType;
  evidenceFlags: Pick<WafEvidence,
    'cfHeaders' | 'sucuriHeaders' | 'sgCaptchaDetected'
    | 'incapsulaCookies' | 'akamaiServer' | 'malcareInBody'
    | 'rapidBurstStatus' | 'sqliRuleFired' | 'xssRuleFired'
    | 'botUaBlocked' | 'honeypotPathsBlocked'
  >;
};

export function classifyWaf(batches: HeavyProbeBatchResult[]): WafClassification {
  const evidence: WafClassification['evidenceFlags'] = {
    cfHeaders: [],
    sucuriHeaders: [],
    sgCaptchaDetected: false,
    incapsulaCookies: [],
    akamaiServer: false,
    malcareInBody: false,
    rapidBurstStatus: 'unknown',
    sqliRuleFired: false,
    xssRuleFired: false,
    botUaBlocked: false,
    honeypotPathsBlocked: false,
  };

  // Scan all batches for vendor markers
  for (const b of batches) {
    const h = b.headers;
    const body = b.bodySnippet;
    if (h['cf-ray']) evidence.cfHeaders!.push(h['cf-ray']);
    if (h['x-sucuri-id'] || /Sucuri\/Cloudproxy/i.test(h['server'] ?? '') || /sucuri_cloudproxy_js/.test(body)) {
      evidence.sucuriHeaders!.push(h['x-sucuri-id'] || h['server']);
    }
    if (h['sg-captcha'] || /\/\.well-known\/sgcaptcha\//.test(body)) evidence.sgCaptchaDetected = true;
    if (h['x-iinfo'] || (h['set-cookie'] && /visid_incap|incap_ses/.test(h['set-cookie']))) {
      evidence.incapsulaCookies!.push(h['x-iinfo'] || 'cookie');
    }
    if (/AkamaiGHost/i.test(h['server'] ?? '')) evidence.akamaiServer = true;
    if (/MalCare WordPress Security Plugin/i.test(body) && /Blocked because of Malicious Activities/i.test(body)) {
      evidence.malcareInBody = true;
    }
    // Per-batch interpretation
    if (b.batchId === 3) evidence.rapidBurstStatus = `${b.status}`;
    if (b.batchId === 6 && b.status && b.status >= 400) evidence.sqliRuleFired = true;
    if (b.batchId === 7 && b.status && b.status >= 400) evidence.xssRuleFired = true;
    if (b.batchId === 4 && b.status && b.status >= 400) evidence.honeypotPathsBlocked = true;
    if (/bot/i.test(b.description) && b.status && b.status >= 400) evidence.botUaBlocked = true;
  }

  // Vendor classification, ordered by specificity
  if (evidence.malcareInBody) return wrap('malcare');
  if (evidence.sgCaptchaDetected) return wrap('sgcaptcha');
  if (evidence.incapsulaCookies!.length > 0) return wrap('incapsula');
  if (evidence.sucuriHeaders!.length > 0) return wrap('sucuri');
  if (evidence.akamaiServer) return wrap('akamai');
  if (evidence.cfHeaders!.length > 0) {
    // Decide active vs passive: only browser-UA challenge counts as active
    const browserBatches = batches.filter(b => b.batchId === 1 || (b.batchId === 2 && /desktop|iphone/i.test(b.description)));
    const activeChallenge = browserBatches.some(b =>
      b.status && b.status >= 400 && /challenge/i.test(b.headers['cf-mitigated'] ?? '')
    );
    return wrap(activeChallenge ? 'cloudflare-active' : 'cloudflare-passive');
  }

  // Origin-rule exclusion: SQLi/XSS blocked but no vendor header → not a WAF
  return { hasWaf: false, wafType: null, evidenceFlags: evidence };

  function wrap(t: WafType): WafClassification {
    // Consistency guard
    return { hasWaf: t !== null, wafType: t, evidenceFlags: evidence };
  }
}
