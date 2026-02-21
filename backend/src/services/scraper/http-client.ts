import axios from 'axios';
import vm from 'vm';
import crypto from 'crypto';
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

// ── Rate limiting ────────────────────────────────────────────────────────────

/** Fixed delay to pace requests (deterministic, no randomness) */
export function randomDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const delay = Math.round((minMs + maxMs) / 2);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Per-domain rate limiter — enforces minimum gap between requests to the same domain */
const domainLastRequest = new Map<string, number>();
const MIN_DOMAIN_GAP_MS = 1000;

async function enforceDomainRateLimit(hostname: string): Promise<void> {
  const domain = normalizeDomain(hostname);
  const last = domainLastRequest.get(domain);
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < MIN_DOMAIN_GAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DOMAIN_GAP_MS - elapsed));
    }
  }
  domainLastRequest.set(domain, Date.now());
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

// ── Main HTTP fetch ──────────────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

/**
 * Fetch a page with:
 * - Manual redirect following (so we can intercept Sucuri challenges at each hop)
 * - Sucuri WAF challenge auto-solving
 * - Per-domain rate limiting
 * - Retry with exponential backoff
 * - Set-Cookie collection across redirect chain
 */
export async function fetchPage(url: string, cookies?: string): Promise<string> {
  let domain: string | undefined;
  try { domain = new URL(url).hostname; } catch {}
  const ua = pickUserAgent(domain);
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
      return await fetchWithRedirects(url, cookies, baseHeaders);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      // Don't retry on errors that won't resolve with retries
      if (msg.includes('status code 4')) break;          // 4xx client errors
      if (msg.includes('ENOTFOUND')) break;               // DNS resolution failed
      if (msg.includes('ECONNREFUSED')) break;            // Connection refused
      if (msg.includes('ERR_TLS_CERT')) break;            // SSL certificate error
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function fetchWithRedirects(
  url: string,
  cookies: string | undefined,
  baseHeaders: Record<string, string>
): Promise<string> {
  let currentUrl = url;
  // Collect cookies from Set-Cookie across the redirect chain
  const collectedCookies: Map<string, string> = new Map();

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let hostname: string;
    try {
      hostname = new URL(currentUrl).hostname;
    } catch {
      hostname = '';
    }

    // Enforce per-domain rate limit
    if (hostname) await enforceDomainRateLimit(hostname);

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

    // Sucuri WAF challenge → solve and retry same URL
    if (html.includes('sucuri_cloudproxy_js')) {
      const sucuriCookie = solveSucuriChallenge(html);
      if (sucuriCookie) {
        console.log(`[HTTP] Solved Sucuri challenge for ${hostname}`);
        if (hostname) cacheSucuriCookie(hostname, sucuriCookie);
        continue; // retry same URL — cached cookie will be picked up next iteration
      }
      console.log(`[HTTP] Could not solve Sucuri challenge for ${hostname}`);
      return html;
    }

    // HTTP redirect — follow manually
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      const nextUrl = new URL(response.headers.location, currentUrl).toString();
      console.log(`[HTTP] Redirect ${response.status}: ${currentUrl} → ${nextUrl}`);
      currentUrl = nextUrl;
      continue;
    }

    return html;
  }

  // Exhausted redirect/challenge attempts — last resort direct fetch
  console.log(`[HTTP] Exhausted ${MAX_REDIRECT_HOPS} hops, falling back to direct fetch for ${currentUrl}`);
  const response = await axios.get(currentUrl, { headers: baseHeaders, timeout: 12000, maxRedirects: 5 });
  return response.data as string;
}
