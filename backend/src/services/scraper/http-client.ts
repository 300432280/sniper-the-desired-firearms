import axios from 'axios';
import vm from 'vm';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { normalizeDomain } from './utils/url';

// ── Deterministic user agent selection ───────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Edge/120.0.0.0',
];

/** Pick a user agent deterministically based on the domain (same domain = same UA every time) */
export function pickUserAgent(domain?: string): string {
  if (!domain) return USER_AGENTS[0];
  const hash = crypto.createHash('md5').update(domain).digest();
  return USER_AGENTS[hash[0] % USER_AGENTS.length];
}

/**
 * Resolve the User-Agent to use for a domain, honoring `siteProfile.userAgentOverride`
 * if present. Falls back to the rotated default from `pickUserAgent`.
 *
 * Some sites (e.g. nginx WAFs that hard-block desktop UAs) require a specific UA
 * — set `siteProfile.userAgentOverride` in the DB. Backward-compatible: sites
 * without an override get the rotated default exactly as before.
 *
 * Uses sync require() to avoid a circular-dep with adapter-registry — matches
 * the existing pattern in adapters (e.g. woocommerce.ts, auction-icollector.ts).
 */
export function resolveUserAgent(domain?: string): string {
  const fallback = pickUserAgent(domain);
  if (!domain) return fallback;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { _getSiteCacheEntry } = require('./adapter-registry');
    const bare = domain.replace(/^www\./, '');
    const entry = _getSiteCacheEntry?.(bare);
    const override = entry?.siteProfile?.userAgentOverride;
    if (override && typeof override === 'string' && override.length > 0) {
      return override;
    }
  } catch { /* cache not initialized yet — use fallback */ }
  return fallback;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Human-like delay with small random jitter.
 * Range is tight (e.g. 1.0-2.0s) to mimic a real person, not a bot.
 */
export function randomDelay(minMs = 1000, maxMs = 2000): Promise<void> {
  const delay = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Per-domain rate limiter — enforces minimum gap between requests to the same domain */
const domainLastRequest = new Map<string, number>();

/** Per-domain cooldown — blocks requests to domains that triggered a security ban (e.g. MalCare) */
const domainCooldown = new Map<string, number>(); // domain → cooldownUntil timestamp
const MALCARE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Enforce per-domain rate limit with difficulty-aware jitter.
 * Easy sites: 1.0-2.0s gap
 * Moderate (difficulty 30-60): 1.5-3.0s gap
 * Difficult (difficulty 60+): 2.5-4.0s gap
 */
async function enforceDomainRateLimit(hostname: string, difficultyRating = 0): Promise<void> {
  const domain = normalizeDomain(hostname);

  // Check domain cooldown (e.g. MalCare ban)
  const cooldownUntil = domainCooldown.get(domain);
  if (cooldownUntil) {
    if (Date.now() < cooldownUntil) {
      throw new Error(`Domain ${domain} is in cooldown until ${new Date(cooldownUntil).toISOString()} (security ban)`);
    }
    domainCooldown.delete(domain); // expired — clean up
  }

  const last = domainLastRequest.get(domain);

  // Scale gap based on difficulty: 0 → 1.0-2.0s, 100 → 2.0-4.0s
  const difficultyMultiplier = 1 + (difficultyRating / 100);
  const minGap = Math.round(1000 * difficultyMultiplier);
  const maxGap = Math.round(2000 * difficultyMultiplier);
  const gap = minGap + Math.floor(Math.random() * (maxGap - minGap));

  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < gap) {
      await new Promise((resolve) => setTimeout(resolve, gap - elapsed));
    }
  }
  domainLastRequest.set(domain, Date.now());
}

// ── Difficulty signal detection ──────────────────────────────────────────────

export interface DifficultySignals {
  hasWaf: boolean;
  hasRateLimit: boolean;
  hasCaptcha: boolean;
}

/**
 * Detect WAF, rate limiting, and CAPTCHA from HTTP response.
 * Called after each fetch — zero extra requests.
 */
export function detectDifficultySignals(
  statusCode: number,
  headers: Record<string, any>,
  body: string
): DifficultySignals {
  return {
    hasWaf: !!(
      headers['cf-ray'] ||
      headers['x-sucuri-id'] ||
      headers['x-sucuri-cache'] ||
      (headers['server'] && /cloudflare/i.test(headers['server'])) ||
      body.includes('sucuri_cloudproxy')
    ),
    hasRateLimit: !!(
      statusCode === 429 ||
      headers['retry-after'] ||
      headers['x-ratelimit-remaining']
    ),
    hasCaptcha: !!(
      body.includes('captcha') ||
      body.includes('recaptcha') ||
      body.includes('hCaptcha') ||
      body.includes('g-recaptcha')
    ),
  };
}

// ── Sucuri WAF challenge solver ──────────────────────────────────────────────

/** Cache: normalized domain → { cookie, expiresAt } */
const sucuriCookieCache = new Map<string, { cookie: string; expiresAt: number }>();

/**
 * Solve a Sucuri/CloudProxy JavaScript challenge.
 * The challenge page contains a Base64-encoded JS snippet that computes a cookie value.
 * We decode it, execute the value-computing part in a sandbox, and extract the cookie name.
 */
export function solveSucuriChallenge(html: string): string | null {
  const sMatch = html.match(/S\s*=\s*'([A-Za-z0-9+/=]+)'/);
  if (!sMatch) return null;

  try {
    const decoded = Buffer.from(sMatch[1], 'base64').toString('utf-8');

    // Decoded JS pattern:
    //   <var>=<value expr>;document.cookie=<name concat>+"=" + <var> + ';path=...';
    const parts = decoded.split('document.cookie');
    if (parts.length < 2) return null;

    const valueAssignment = parts[0].trim().replace(/;$/, '');
    const cookieAssignment = parts[1];

    // Run the value assignment in a sandbox
    const sandbox: Record<string, any> = { String };
    vm.runInNewContext(valueAssignment, sandbox, { timeout: 500 });

    // Find the variable name (first identifier assigned)
    const varMatch = valueAssignment.match(/^([a-zA-Z_]\w*)\s*=/);
    if (!varMatch) return null;
    const cookieValue = sandbox[varMatch[1]];
    if (!cookieValue) return null;

    // Extract cookie name expression between "=" and '+"="'
    const nameMatch = cookieAssignment.match(/=\s*((?:['"][^'"]*['"]\s*\+\s*)*['"][^'"]*['"])\s*\+\s*"="/);
    if (!nameMatch) return null;

    const nameSandbox: Record<string, any> = { result: '' };
    vm.runInNewContext(`result = ${nameMatch[1]}`, nameSandbox, { timeout: 500 });
    const cookieName = nameSandbox.result;

    if (!cookieName) return null;
    return `${cookieName}=${cookieValue}`;
  } catch {
    return null;
  }
}

/** Get cached Sucuri cookie for a hostname (auto-normalizes www.) */
function getCachedSucuriCookie(hostname: string): string | undefined {
  const domain = normalizeDomain(hostname);
  const cached = sucuriCookieCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.cookie;
  // Also check without normalization as fallback
  const rawCached = sucuriCookieCache.get(hostname);
  if (rawCached && rawCached.expiresAt > Date.now()) return rawCached.cookie;
  return undefined;
}

/** Store a Sucuri cookie (normalizes domain key) */
function cacheSucuriCookie(hostname: string, cookie: string): void {
  const domain = normalizeDomain(hostname);
  const entry = { cookie, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  sucuriCookieCache.set(domain, entry);
  // Also store under raw hostname for direct lookups
  if (hostname !== domain) {
    sucuriCookieCache.set(hostname, entry);
  }
}

// ── Collect Set-Cookie from responses ────────────────────────────────────────

/** Parse Set-Cookie headers into "name=value" pairs */
function parseSetCookies(headers: Record<string, any>): string[] {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return [];
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  return arr.map((c: string) => c.split(';')[0]);
}

// ── Fetch result with metadata ───────────────────────────────────────────────

export interface FetchResult {
  html: string;
  responseTimeMs: number;
  statusCode: number;
  signals: DifficultySignals;
  headers: Record<string, any>;
}

// ── Main HTTP fetch ──────────────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

export interface FetchOptions {
  difficultyRating?: number;
}

/**
 * Fetch a page with:
 * - Manual redirect following (so we can intercept Sucuri challenges at each hop)
 * - Sucuri WAF challenge auto-solving
 * - Per-domain rate limiting (difficulty-aware)
 * - Retry with exponential backoff
 * - Set-Cookie collection across redirect chain
 * - Difficulty signal detection from response
 */
/** Block SSRF: reject internal/private network URLs */
function validateExternalUrl(url: string): void {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
    '169.254.169.254', // cloud metadata
    'metadata.google.internal',
  ];
  if (blocked.includes(hostname)) throw new Error(`SSRF blocked: ${hostname}`);
  // Block private IP ranges
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) throw new Error(`SSRF blocked: private IP ${hostname}`);
  // Block non-HTTP schemes
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`SSRF blocked: invalid protocol ${parsed.protocol}`);
}

export async function fetchPage(url: string, cookies?: string, options?: FetchOptions): Promise<string> {
  validateExternalUrl(url);
  const result = await fetchPageWithMeta(url, cookies, options);
  return result.html;
}

/**
 * Native fetch fallback for servers with non-standard HTTP headers that Axios can't parse.
 *
 * On Node 24, the native (undici-based) fetch also rejects malformed headers — Celerant
 * ColdFusion emits headers like `X-Frame-Options : SAMEORIGIN` (literal space before colon)
 * which violates RFC 7230. When fetch fails with a parse error we fall through to a
 * curl child-process spawn, which is the only HTTP client lenient enough to accept those
 * responses on Node 24.
 */
async function nativeFetchFallback(
  url: string,
  headers: Record<string, string>,
  cookies?: string,
): Promise<FetchResult> {
  const startTime = Date.now();
  const fetchHeaders: Record<string, string> = { ...headers };
  if (cookies) fetchHeaders['Cookie'] = cookies;

  try {
    const resp = await fetch(url, {
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const html = await resp.text();
    const responseTimeMs = Date.now() - startTime;

    return {
      html,
      responseTimeMs,
      statusCode: resp.status,
      signals: { hasWaf: false, hasRateLimit: false, hasCaptcha: false },
      headers: Object.fromEntries(resp.headers.entries()),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Node 24 undici-based fetch fails on malformed headers — fall through to curl.
    if (
      msg.includes('Parse Error') ||
      msg.includes('HPE_INVALID') ||
      msg.includes('header parsing failed') ||
      msg.includes('Invalid header')
    ) {
      console.log(`[HTTP] Native fetch parse error for ${url}, falling back to curl-spawn`);
      return await curlSpawnFallback(url, headers, cookies);
    }
    throw err;
  }
}

/**
 * Last-resort fallback: spawn `curl` as a child process. Curl is the only HTTP client
 * lenient enough to parse Celerant-style malformed headers on Node 24. Used only when
 * both axios and native fetch fail with HPE_INVALID_HEADER_TOKEN / parse errors.
 *
 * Requires `curl` to be on PATH (default on Windows 10+, macOS, and most Linux distros).
 */
async function curlSpawnFallback(
  url: string,
  headers: Record<string, string>,
  cookies?: string,
): Promise<FetchResult> {
  const startTime = Date.now();

  const args: string[] = [
    '-sSL',           // silent + show errors + follow redirects
    '--max-time', '15',
    '-i',             // include response headers in stdout
    '--compressed',   // accept gzip/deflate
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }
  if (cookies) args.push('-H', `Cookie: ${cookies}`);
  args.push(url);

  return await new Promise<FetchResult>((resolve, reject) => {
    const proc = spawn('curl', args, { windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeoutHandle = setTimeout(() => {
      proc.kill();
      finish(() => reject(new Error(`curl-spawn timeout after 18s for ${url}`)));
    }, 18000);

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      finish(() => reject(new Error(`curl-spawn failed to start: ${err.message}`)));
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        finish(() => reject(new Error(`curl-spawn exit code ${code} for ${url}: ${stderr.substring(0, 200)}`)));
        return;
      }
      const responseTimeMs = Date.now() - startTime;
      const fullOutput = Buffer.concat(stdoutChunks).toString('utf-8');

      // With -L, curl emits one header block per redirect hop, separated by blank lines.
      // We want the LAST header block (final response) + everything after it (body).
      const blocks = fullOutput.split(/\r?\n\r?\n/);
      let statusBlockIdx = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (/^HTTP\/[\d.]+\s+\d+/.test(blocks[i])) {
          statusBlockIdx = i;
          break;
        }
      }

      if (statusBlockIdx === -1) {
        // Couldn't find a status line — return raw output as body, 200 OK.
        finish(() => resolve({
          html: fullOutput,
          responseTimeMs,
          statusCode: 200,
          signals: { hasWaf: false, hasRateLimit: false, hasCaptcha: false },
          headers: {},
        }));
        return;
      }

      const headerLines = blocks[statusBlockIdx].split(/\r?\n/);
      const statusMatch = headerLines[0].match(/HTTP\/[\d.]+\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

      const responseHeaders: Record<string, string> = {};
      for (let i = 1; i < headerLines.length; i++) {
        const idx = headerLines[i].indexOf(':');
        if (idx > 0) {
          const name = headerLines[i].substring(0, idx).trim().toLowerCase();
          const value = headerLines[i].substring(idx + 1).trim();
          responseHeaders[name] = value;
        }
      }

      const body = blocks.slice(statusBlockIdx + 1).join('\n\n');

      finish(() => resolve({
        html: body,
        responseTimeMs,
        statusCode,
        signals: { hasWaf: false, hasRateLimit: false, hasCaptcha: false },
        headers: responseHeaders,
      }));
    });
  });
}

/**
 * Fetch a page and return metadata (response time, signals, status code).
 * Used by the crawler to record CrawlEvents and update site metrics.
 */
export async function fetchPageWithMeta(url: string, cookies?: string, options?: FetchOptions): Promise<FetchResult> {
  let domain: string | undefined;
  try { domain = new URL(url).hostname; } catch {}
  const ua = resolveUserAgent(domain);
  const difficultyRating = options?.difficultyRating ?? 0;
  const baseHeaders: Record<string, string> = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  let lastError: Error | null = null;

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    if (retry > 0) {
      const backoff = RETRY_BASE_MS * Math.pow(2, retry - 1);
      console.log(`[HTTP] Retry ${retry}/${MAX_RETRIES} for ${url} (waiting ${backoff}ms)`);
      await new Promise((r) => setTimeout(r, backoff));
    }

    try {
      return await fetchWithRedirects(url, cookies, baseHeaders, difficultyRating);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      // Don't retry on errors that won't resolve with retries
      if (msg.includes('status code 4')) break;          // 4xx client errors
      if (msg.includes('ENOTFOUND')) break;               // DNS resolution failed
      if (msg.includes('ECONNREFUSED')) break;            // Connection refused
      if (msg.includes('ERR_TLS_CERT')) break;            // SSL certificate error
      // Axios can't handle non-standard headers — fall back to native fetch
      if (msg.includes('Parse Error')) {
        console.log(`[HTTP] Axios parse error for ${url}, falling back to native fetch`);
        return await nativeFetchFallback(url, baseHeaders, cookies);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function fetchWithRedirects(
  url: string,
  cookies: string | undefined,
  baseHeaders: Record<string, string>,
  difficultyRating: number
): Promise<FetchResult> {
  let currentUrl = url;
  // Collect cookies from Set-Cookie across the redirect chain
  const collectedCookies: Map<string, string> = new Map();
  const startTime = Date.now();

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let hostname: string;
    try {
      hostname = new URL(currentUrl).hostname;
    } catch {
      hostname = '';
    }

    // Enforce per-domain rate limit with difficulty-aware jitter
    if (hostname) await enforceDomainRateLimit(hostname, difficultyRating);

    // Build Cookie header
    const headers = { ...baseHeaders };
    const cookieParts: string[] = [];
    if (cookies) cookieParts.push(cookies);

    // Add cached Sucuri cookie for this domain
    const cachedSucuri = hostname ? getCachedSucuriCookie(hostname) : undefined;
    if (cachedSucuri) cookieParts.push(cachedSucuri);

    // Add collected Set-Cookie from prior redirect hops
    if (collectedCookies.size > 0) {
      cookieParts.push([...collectedCookies.values()].join('; '));
    }

    if (cookieParts.length) headers['Cookie'] = cookieParts.join('; ');

    const response = await axios.get(currentUrl, {
      headers,
      timeout: 12000,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    // Collect Set-Cookie from this response
    for (const pair of parseSetCookies(response.headers)) {
      const [name] = pair.split('=');
      if (name) collectedCookies.set(name, pair);
    }

    const html = typeof response.data === 'string' ? response.data : '';
    const responseTimeMs = Date.now() - startTime;

    // Handle 429 rate limiting — throw to trigger retry with backoff
    if (response.status === 429) {
      const retryAfter = response.headers['retry-after'];
      console.log(`[HTTP] 429 rate limited for ${currentUrl}${retryAfter ? ` (retry-after: ${retryAfter})` : ''}`);
      throw new Error(`Rate limited (429) for ${currentUrl}`);
    }

    // Detect difficulty signals from response
    const signals = detectDifficultySignals(response.status, response.headers, html);

    // MalCare WordPress security ban → set domain cooldown
    if (response.status === 403 && html.includes('MalCare')) {
      const domain = normalizeDomain(hostname);
      domainCooldown.set(domain, Date.now() + MALCARE_COOLDOWN_MS);
      console.warn(`[HTTP] MalCare ban detected on ${domain} — cooldown ${MALCARE_COOLDOWN_MS / 60000}min`);
      return { html, responseTimeMs, statusCode: 403, signals, headers: response.headers };
    }

    // Sucuri WAF challenge → solve and retry same URL
    if (html.includes('sucuri_cloudproxy_js')) {
      const sucuriCookie = solveSucuriChallenge(html);
      if (sucuriCookie) {
        console.log(`[HTTP] Solved Sucuri challenge for ${hostname}`);
        if (hostname) cacheSucuriCookie(hostname, sucuriCookie);
        continue; // retry same URL — cached cookie will be picked up next iteration
      }
      console.log(`[HTTP] Could not solve Sucuri challenge for ${hostname}`);
      return { html, responseTimeMs, statusCode: response.status, signals, headers: response.headers };
    }

    // HTTP redirect — follow manually
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      const nextUrl = new URL(response.headers.location, currentUrl).toString();
      console.log(`[HTTP] Redirect ${response.status}: ${currentUrl} → ${nextUrl}`);
      currentUrl = nextUrl;
      continue;
    }

    return { html, responseTimeMs, statusCode: response.status, signals, headers: response.headers };
  }

  // Exhausted redirect/challenge attempts — last resort direct fetch
  console.log(`[HTTP] Exhausted ${MAX_REDIRECT_HOPS} hops, falling back to direct fetch for ${currentUrl}`);
  const response = await axios.get(currentUrl, { headers: baseHeaders, timeout: 12000, maxRedirects: 5 });
  const html = response.data as string;
  const responseTimeMs = Date.now() - startTime;
  const signals = detectDifficultySignals(response.status, response.headers, html);
  return { html, responseTimeMs, statusCode: response.status, signals, headers: response.headers };
}
