// backend/scripts/probe/shared/fetch.ts
// WAF-aware fetch primitive used by all rooms.
// Layers: axios (with HPE native-fetch fallback) → Playwright → Playwright + cookies.
// Cherry-picked from probe-fetch.ts (prior session): native-fetch HPE fallback,
// Redis cookie cache integration, iPhone UA auto-switch on WAF-suspected.

import axios, { AxiosError } from 'axios';
import * as https from 'https';
import * as http from 'http';
import { spawn } from 'child_process';
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
  method: 'axios' | 'native-fetch' | 'curl-subprocess' | 'playwright' | 'playwright-cookies';
  cookiesUsed?: string;
};

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Last-resort fallback for servers whose headers violate RFC 7230 in ways
 * BOTH the Node http parser (axios) AND undici reject — e.g. Celerant ColdFusion
 * sites that emit `X-Frame-Options : SAMEORIGIN` (space before colon).
 * Curl's parser is more permissive and round-trips these responses cleanly.
 * Mistake 36 — see `.claude/catalog-url-discovery-playbook.md`.
 */
async function curlSubprocessFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const timeoutSec = Math.ceil((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
  const args: string[] = ['-sS', '-i', '-L', '--max-time', String(timeoutSec)];
  args.push('-A', opts.ua ?? UA_DESKTOP);
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    args.push('-H', `${k}: ${v}`);
  }
  if (opts.method === 'HEAD') args.push('-I');
  else if (opts.method === 'POST') {
    args.push('-X', 'POST');
    if (opts.body) args.push('--data-binary', opts.body);
  }
  args.push(url);

  return await new Promise<FetchResult>((resolve, reject) => {
    const child = spawn('curl', args, { windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`curl exit ${code}: ${stderr.slice(0, 200)}`));
      }
      const raw = Buffer.concat(stdoutChunks).toString('utf-8');
      // Split into hops on blank line; the LAST HTTP/N.N hop is the final response
      const hops = raw.split(/\r?\n\r?\n/);
      let finalIdx = -1;
      for (let i = hops.length - 1; i >= 0; i--) {
        if (/^HTTP\/[\d.]+\s+\d/.test(hops[i])) { finalIdx = i; break; }
      }
      if (finalIdx < 0) {
        return reject(new Error('curl output had no HTTP status line'));
      }
      const headerBlock = hops[finalIdx];
      const body = hops.slice(finalIdx + 1).join('\r\n\r\n');
      const lines = headerBlock.split(/\r?\n/);
      const m = /^HTTP\/[\d.]+\s+(\d+)/.exec(lines[0]);
      const status = m ? parseInt(m[1], 10) : 0;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        // Trim trailing whitespace from name to tolerate "X-Frame-Options : VAL"
        const name = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (headers[name]) headers[name] += ', ' + val;
        else headers[name] = val;
      }
      resolve({
        status,
        headers,
        body,
        bodyBytes: body.length,
        durationMs: Date.now() - start,
        method: 'curl-subprocess',
      });
    });
  });
}

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
    // HPE_INVALID_HEADER_TOKEN — Celerant trailing-space headers (Mistake 36).
    // Cascade: axios → undici (native fetch) → curl subprocess. Some Celerant sites
    // (e.g. bullseyenorth.com — `X-Frame-Options : SAMEORIGIN` with space-before-colon)
    // are rejected by BOTH llhttp (axios) and undici. Curl's parser is permissive.
    if (ae.code === 'HPE_INVALID_HEADER_TOKEN' || /Parse Error|Invalid header/i.test(ae.message ?? '')) {
      try {
        return await nativeFetchText(url, opts);
      } catch (nfErr) {
        const nfMsg = (nfErr as Error).message ?? '';
        const nfCauseMsg = ((nfErr as { cause?: Error }).cause)?.message ?? '';
        if (/Invalid header|Parse Error/i.test(nfMsg) || /Invalid header|Parse Error/i.test(nfCauseMsg)) {
          return await curlSubprocessFetch(url, opts);
        }
        throw nfErr;
      }
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

// Alias kept for callers that prefer the safeFetch name
export const safeFetch = fetchUrl;
