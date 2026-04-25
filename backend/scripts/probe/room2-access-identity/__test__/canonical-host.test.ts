// backend/scripts/probe/room2-access-identity/__test__/canonical-host.test.ts
import { describe, it, expect } from 'vitest';
import { hasChallengeMarkers } from '../canonical-host';

describe('hasChallengeMarkers', () => {
  it('detects Cloudflare challenge body', () => {
    expect(hasChallengeMarkers('<html><title>Just a moment...</title>...cf-mitigated...</html>')).toBe(true);
  });
  it('detects sgcaptcha meta-refresh', () => {
    expect(hasChallengeMarkers('<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=...">')).toBe(true);
  });
  it('detects Sucuri body marker', () => {
    expect(hasChallengeMarkers('sucuri_cloudproxy_js')).toBe(true);
  });
  it('does NOT match real product page that mentions cdn-cgi/challenge-platform in JS bundle', () => {
    expect(hasChallengeMarkers('<html>...</html>'.padEnd(60000, ' ') + 'cdn-cgi/challenge-platform')).toBe(false);
    // Body too large to be a real challenge page
  });
});
