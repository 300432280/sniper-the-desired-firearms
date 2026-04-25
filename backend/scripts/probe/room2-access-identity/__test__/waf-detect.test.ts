// backend/scripts/probe/room2-access-identity/__test__/waf-detect.test.ts
import { describe, it, expect } from 'vitest';
import { classifyWaf } from '../waf-detect';
import type { HeavyProbeBatchResult } from '../../shared/types';

function batch(id: number, desc: string, status: number, headers: Record<string,string>, body = ''): HeavyProbeBatchResult {
  return { batchId: id, description: desc, status, headers, bodySnippet: body, durationMs: 0 };
}

describe('classifyWaf', () => {
  it('classifies CF passive (cf-ray on every 200, no challenge)', () => {
    const batches = [
      batch(1, 'header fingerprint',    200, { 'cf-ray': 'abc-YYZ', server: 'cloudflare' }),
      batch(2, 'multi-UA desktop',      200, { 'cf-ray': 'def-YYZ', server: 'cloudflare' }),
      batch(3, 'rapid burst',           200, { 'cf-ray': 'ghi-YYZ' }),
      batch(6, 'sqli query',            200, {}),
      batch(7, 'xss query',             200, {}),
    ];
    const r = classifyWaf(batches);
    expect(r.hasWaf).toBe(true);
    expect(r.wafType).toBe('cloudflare-passive');
  });

  it('does NOT classify CF active just because curl/bot UA gets 403', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'cf-ray': 'a', server: 'cloudflare' }),
      batch(2, 'multi-UA desktop',   200, { 'cf-ray': 'b' }),
      batch(2, 'multi-UA bot',       403, { 'cf-ray': 'c' }),  // CF Bot Fight Mode — passive, not active
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('cloudflare-passive');  // NOT 'cloudflare-active'
  });

  it('classifies sgcaptcha (HTTP 202 + sg-captcha header)', () => {
    const batches = [
      batch(1, 'header fingerprint', 202, { 'sg-captcha': 'challenge' }, '<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/">'),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sgcaptcha');
  });

  it('classifies Sucuri (x-sucuri-id header)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'x-sucuri-id': '20017', server: 'Sucuri/Cloudproxy' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sucuri');
  });

  it('classifies Akamai (server: AkamaiGHost)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { server: 'AkamaiGHost' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('akamai');
  });

  it('classifies MalCare from body marker', () => {
    const batches = [
      batch(1, 'header fingerprint', 403, { server: 'Apache' }, '<title>MalCare WordPress Security Plugin</title>Blocked because of Malicious Activities Reference ID: abc123'),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('malcare');
  });

  it('does NOT classify mod_security as WAF (origin-rule exclusion)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { server: 'Apache' }),
      batch(6, 'sqli query',         403, { server: 'Apache' }),  // mod_security blocks SQLi
      batch(7, 'xss query',          403, { server: 'Apache' }),  // mod_security blocks XSS
    ];
    const r = classifyWaf(batches);
    expect(r.hasWaf).toBe(false);
    expect(r.wafType).toBeNull();
  });

  it('consistency guard: hasWaf forced to true when wafType is non-null', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'x-sucuri-id': '1' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sucuri');
    expect(r.hasWaf).toBe(true);
  });
});
