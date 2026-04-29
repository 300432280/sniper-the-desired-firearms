// backend/scripts/probe/shared/fetch.ts
// WAF-aware fetch primitive used by all rooms.
// Layers: axios (with HPE native-fetch fallback) → Playwright → Playwright + cookies.
// Cherry-picked from probe-fetch.ts (prior session): native-fetch HPE fallback,
// Redis cookie cache integration, iPhone UA auto-switch on WAF-suspected.

import axios, { AxiosError } from 'axios';
import * as https from 'https';
import * as http from 'http';
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
  method?: 'GET' | 'POST' | 'HEAD';
  body?: string;
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
      method: opts.method ?? 'GET',
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      body: opts.body ?? undefined,
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
    const axiosOpts = {
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true as const,
      maxRedirects: 5,
      responseType: 'text' as const,
      transformResponse: [(d: any) => d],
    };
    const res = opts.method === 'POST'
      ? await axios.post(url, opts.body, axiosOpts)
      : opts.method === 'HEAD'
      ? await axios.head(url, axiosOpts)
      : await axios.get(url, axiosOpts);
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
    // HPE_HEADER_OVERFLOW — Drupal x-drupal-cache-tags >16KB — retry with larger header limit.
    // MUST be checked BEFORE HPE_INVALID_HEADER_TOKEN because "Parse Error: Header overflow"
    // matches the generic /Parse Error/ regex in the HPE_INVALID_HEADER_TOKEN catch.
    if (ae.code === 'HPE_HEADER_OVERFLOW' || /Header overflow/i.test(ae.message ?? '')) {
      return axiosLargeHeaderFetch(url, opts);
    }
    // HPE_INVALID_HEADER_TOKEN — Celerant trailing-space headers — fall back to native fetch
    if (ae.code === 'HPE_INVALID_HEADER_TOKEN' || /Parse Error|Invalid header/i.test(ae.message ?? '')) {
      return nativeFetchText(url, opts);
    }
    throw err;
  }
}

/**
 * Large-header fetch using raw Node HTTP for sites with >16KB response headers
 * (e.g. Drupal x-drupal-cache-tags).
 * Axios + follow-redirects don't propagate maxHeaderSize to ClientRequest,
 * so we use Node's built-in https.request with the option directly.
 * Follows up to 5 redirects manually.
 */
async function axiosLargeHeaderFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function doRequest(targetUrl: string, redirectCount: number): Promise<FetchResult> {
    if (redirectCount > 5) throw new Error('Too many redirects');
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    return new Promise<FetchResult>((resolve, reject) => {
      const reqOpts: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: opts.method ?? 'GET',
        headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
        maxHeaderSize: 65536,
        timeout: timeoutMs,
      };

      const req = mod.request(reqOpts, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, targetUrl).toString();
          res.resume(); // drain response
          resolve(doRequest(redirectUrl, redirectCount + 1));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body,
            bodyBytes: body.length,
            durationMs: Date.now() - start,
            method: 'axios', // label as axios for compatibility
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (opts.body && opts.method === 'POST') req.write(opts.body);
      req.end();
    });
  }

  return doRequest(url, 0);
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

// Alias used by room5-bootstrap modules
export const safeFetch = fetchUrl;
