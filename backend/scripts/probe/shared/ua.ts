// backend/scripts/probe/shared/ua.ts
// UA escalation ladder per spec §1.1 (Room 2 access method).
// Bot UAs (curl, python-requests) are for heavy-probe Batch 2 vendor detection ONLY,
// never for site access — they guarantee WAF triggers on protected sites.

import type { WafType, AccessMethod } from './types';

export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
export const UA_BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
export const UA_PYTHON = 'python-requests/2.31.0';
export const UA_CURL = 'curl/8.1.2';

type UaLadderStep = { id: AccessMethod; ua: string; usePlaywright: boolean; useCookies: boolean; channel?: 'chrome' };

// Ladder for ACCESS — never includes bot UAs.
export const UA_LADDER: UaLadderStep[] = [
  { id: 'axios-desktop',                ua: UA_DESKTOP, usePlaywright: false, useCookies: false },
  { id: 'axios-iphone',                 ua: UA_IPHONE,  usePlaywright: false, useCookies: false },
  { id: 'playwright-chromium',          ua: UA_DESKTOP, usePlaywright: true,  useCookies: false },
  { id: 'playwright-iphone-cookies',    ua: UA_IPHONE,  usePlaywright: true,  useCookies: true },
  { id: 'playwright-real-chrome',       ua: UA_DESKTOP, usePlaywright: true,  useCookies: true, channel: 'chrome' },
];

// For WAF-suspected fetches, pick the UA most likely to succeed.
// Mistake 30 Fix B: sgcaptcha + Sucuri (with UA filter) require iPhone post-challenge.
export function pickUaForWaf(wafType: WafType): string {
  if (wafType === 'sgcaptcha') return UA_IPHONE;
  if (wafType === 'sucuri') return UA_IPHONE;  // doctordeals precedent
  return UA_DESKTOP;
}
