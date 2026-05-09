// backend/scripts/probe/access-identity/waf-detect.ts
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
      // Fall back to a marker string when detection was body-only (no header to record)
      evidence.sucuriHeaders!.push(h['x-sucuri-id'] || h['server'] || 'body-marker');
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
    // Active vs passive: only batch 1 (header-fingerprint sub-probes 1a/1b/1c) emits
    // headers, so only batch 1 can carry cf-mitigated:challenge. Batches 2-8 use the
    // bash script's compact STATUS=NNN format with no headers (waf-heavy-probe.ts:30).
    // Bot/curl 403s from CF Bot Fight Mode appear in batch 2-8 STATUS lines, NOT here —
    // by limiting to batch 1, we naturally exclude them per Mistake 23 guidance.
    const batch1 = batches.find(b => b.batchId === 1);
    const activeChallenge = !!(batch1 && batch1.status && batch1.status >= 400
      && /challenge/i.test(batch1.headers['cf-mitigated'] ?? ''));
    if (activeChallenge) return wrap('cloudflare-active');
    // CF passive — but if OWASP rules also fired (SQLi/XSS/honeypot), upgrade tag.
    // Per audit history precisionoptics.net: CF + active OWASP rules = distinct WAF state.
    if (evidence.sqliRuleFired || evidence.xssRuleFired || evidence.honeypotPathsBlocked) {
      return wrap('cloudflare-passive-with-owasp');
    }
    return wrap('cloudflare-passive');
  }

  // Origin-rule exclusion: SQLi/XSS blocked but no vendor header → not a WAF
  return { hasWaf: false, wafType: null, evidenceFlags: evidence };

  function wrap(t: WafType): WafClassification {
    // Consistency guard
    return { hasWaf: t !== null, wafType: t, evidenceFlags: evidence };
  }
}
