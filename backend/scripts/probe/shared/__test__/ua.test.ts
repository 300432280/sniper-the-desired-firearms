// backend/scripts/probe/shared/__test__/ua.test.ts
import { describe, it, expect } from 'vitest';
import { UA_LADDER, pickUaForWaf, UA_DESKTOP, UA_IPHONE, UA_BOT, UA_PYTHON } from '../ua';

describe('UA_LADDER', () => {
  it('starts with desktop, iphone before any bot UA', () => {
    expect(UA_LADDER[0].id).toBe('axios-desktop');
    expect(UA_LADDER[1].id).toBe('axios-iphone');
    // Bot UAs are not in the ladder — they're for heavy-probe vendor detection only
    expect(UA_LADDER.find(s => s.ua.includes('python-requests'))).toBeUndefined();
    expect(UA_LADDER.find(s => s.ua.includes('curl/'))).toBeUndefined();
  });
});

describe('pickUaForWaf', () => {
  it('picks iPhone for sgcaptcha (Mistake 30 Fix B)', () => {
    expect(pickUaForWaf('sgcaptcha')).toBe(UA_IPHONE);
  });
  it('picks iPhone for Sucuri with UA-filter (doctordeals precedent)', () => {
    expect(pickUaForWaf('sucuri')).toBe(UA_IPHONE);
  });
  it('picks iPhone for Incapsula (matches access-identity orchestrator policy)', () => {
    expect(pickUaForWaf('incapsula')).toBe(UA_IPHONE);
  });
  it('picks desktop for cloudflare-passive', () => {
    expect(pickUaForWaf('cloudflare-passive')).toBe(UA_DESKTOP);
  });
  it('picks desktop for null wafType', () => {
    expect(pickUaForWaf(null)).toBe(UA_DESKTOP);
  });
});

describe('UA constants', () => {
  it('UA_DESKTOP looks like a real Chrome', () => {
    expect(UA_DESKTOP).toMatch(/Chrome\/\d+\.\d+/);
  });
  it('UA_IPHONE looks like Safari iOS', () => {
    expect(UA_IPHONE).toMatch(/iPhone.*Safari/);
  });
});
