// backend/scripts/probe/shared/fetch.ts
// WAF-aware fetch primitive used by all rooms.
// Layers: axios (with HPE native-fetch fallback) → Playwright → Playwright + cookies.
// Cherry-picked from probe-fetch.ts (prior session): native-fetch HPE fallback,
// Redis cookie cache integration, iPhone UA auto-switch on WAF-suspected.

import axios, { AxiosError } from 'axios';
import { fetchWithPlaywright } from '../../../src/services/scraper/playwright-fetcher';
import { getCachedCookies } from './redis-cookies';
import { UA_DESKTOP, UA_IPHONE, pickUaForWaf } from './ua';
import type { WafType } from './types';

export type FetchOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  ua?: string;
  hasWaf?: boolean;
  wafType?: WafType;
  forcePlaywright?: boolean;
};

export type FetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  durationMs: number;
  method: 'axios' | 'native-fetch' | 'playwright' | 'playwright-cookies';
  cookiesUsed?: string;
};

const DEFAULT_TIMEOUT_MS = 30000;

async function nativeFetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return {
      status: res.status,
      headers,
      body,
      bodyBytes: body.length,
      durationMs: Date.now() - start,
      method: 'native-fetch',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function axiosFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: 5,
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      headers[k.toLowerCase()] = String(v);
    }
    return {
      status: res.status,
      headers,
      body: res.data as string,
      bodyBytes: (res.data as string).length,
      durationMs: Date.now() - start,
      method: 'axios',
    };
  } catch (err) {
    const ae = err as AxiosError & { code?: string };
    // HPE_INVALID_HEADER_TOKEN — Celerant trailing-space headers — fall back to native fetch
    if (ae.code === 'HPE_INVALID_HEADER_TOKEN' || /Parse Error|Invalid header/i.test(ae.message ?? '')) {
      return nativeFetchText(url, opts);
    }
    throw err;
  }
}

type PlaywrightFetchExtra = { cookies?: string; injectedCookies?: string };

async function playwrightFetch(url: string, opts: FetchOptions & PlaywrightFetchExtra): Promise<FetchResult> {
  const start = Date.now();
  // production fetchWithPlaywright signature (playwright-fetcher.ts:113):
  //   { timeout?: number; waitForSelector?: string; userAgent?: string; cookies?: string }
  const ua = opts.ua ?? (opts.wafType ? pickUaForWaf(opts.wafType) : UA_DESKTOP);
  const result = await fetchWithPlaywright(url, {
    timeout: opts.timeoutMs ?? 45000,
    userAgent: ua,
    cookies: opts.cookies,
  });
  return {
    // NOTE: production fetchWithPlaywright doesn't expose HTTP status — returns 200 if it
    // didn't throw. Callers MUST inspect body for challenge markers (e.g. via
    // hasChallengeMarkers in canonical-host) — a rendered 403 challenge page returns 200 here.
    status: 200,
    headers: {},
    body: result.html,
    bodyBytes: result.html.length,
    durationMs: Date.now() - start,
    method: opts.injectedCookies ? 'playwright-cookies' : 'playwright',
    ...(opts.injectedCookies ? { cookiesUsed: opts.injectedCookies } : {}),
  };
}

export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  // Use Playwright when forced OR any WAF flag is set (vendor may still be unclassified).
  // Mistake: prior dispatch required (hasWaf && wafType !== null) — that silently sent
  // hasWaf=true sites through axios when vendor classification was still in progress.
  if (opts.forcePlaywright || opts.hasWaf) {
    const host = new URL(url).hostname;
    // Production waf-cookie-manager.ts:27 strips www. before lookup — match that.
    const domain = host.replace(/^www\./, '');
    const cached = await getCachedCookies(domain);
    if (cached) {
      // Inject cookies into the Playwright context (via production parameter added in this commit)
      // and use the UA that acquired them (production validates UA match — Mistake 30 Fix B).
      return playwrightFetch(url, {
        ...opts,
        ua: cached.userAgent,
        cookies: cached.cookies,
        injectedCookies: cached.cookies,
      });
    }
    return playwrightFetch(url, opts);
  }
  // Default path: axios first, native-fetch on HPE
  return axiosFetch(url, opts);
}
