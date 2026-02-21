import axios from 'axios';
import * as cheerio from 'cheerio';
import { fetchPage } from './scraper';

/**
 * Authenticate to a forum and return serialized cookies for subsequent requests.
 * Both CGN and Gun Owners of Canada run XenForo.
 */

const FORUM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── vBulletin login (Canadian Gun Nutz) ────────────────────────────────────────

async function loginVBulletin(baseUrl: string, username: string, password: string): Promise<string> {
  const loginUrl = `${baseUrl}/forum/login.php?do=login`;

  const params = new URLSearchParams({
    vb_login_username: username,
    vb_login_password: password,
    do: 'login',
    securitytoken: 'guest',
    cookieuser: '1',
  });

  const response = await axios.post(loginUrl, params.toString(), {
    headers: {
      'User-Agent': FORUM_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${baseUrl}/forum/`,
    },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  // Extract Set-Cookie headers
  const setCookies = response.headers['set-cookie'];
  if (!setCookies || setCookies.length === 0) {
    throw new Error('vBulletin login failed — no cookies received');
  }

  // Serialize cookies for future requests
  const cookies = setCookies
    .map((c: string) => c.split(';')[0])
    .join('; ');

  // Verify we got a session cookie
  if (!cookies.includes('bbsessionhash') && !cookies.includes('bblastvisit')) {
    throw new Error('vBulletin login failed — session cookie not found');
  }

  return cookies;
}

// ── XenForo login (Gun Owners of Canada) ───────────────────────────────────────

async function loginXenForo(baseUrl: string, username: string, password: string): Promise<string> {
  // Step 1: Fetch login page to get CSRF token
  const loginPageUrl = `${baseUrl}/login/`;
  const loginPageHtml = await fetchPage(loginPageUrl);
  const $ = cheerio.load(loginPageHtml);

  // XenForo uses _xfToken as CSRF token
  const xfToken = $('input[name="_xfToken"]').val() as string;
  if (!xfToken) {
    throw new Error('XenForo login failed — could not find CSRF token');
  }

  // Step 2: POST login credentials
  const loginUrl = `${baseUrl}/login/login`;
  const params = new URLSearchParams({
    login: username,
    password: password,
    _xfToken: xfToken,
    remember: '1',
  });

  const response = await axios.post(loginUrl, params.toString(), {
    headers: {
      'User-Agent': FORUM_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: loginPageUrl,
    },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const setCookies = response.headers['set-cookie'];
  if (!setCookies || setCookies.length === 0) {
    throw new Error('XenForo login failed — no cookies received');
  }

  const cookies = setCookies
    .map((c: string) => c.split(';')[0])
    .join('; ');

  // XenForo session cookie
  if (!cookies.includes('xf_session') && !cookies.includes('xf_user')) {
    throw new Error('XenForo login failed — session cookie not found');
  }

  return cookies;
}

// ── Detect forum type from domain ──────────────────────────────────────────────

type ForumType = 'vbulletin' | 'xenforo' | 'unknown';

function detectForumType(domain: string): ForumType {
  const d = domain.toLowerCase();
  if (d.includes('canadiangunnutz.com')) return 'xenforo';
  if (d.includes('gunownersofcanada.ca')) return 'xenforo';
  return 'unknown';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Log in to a forum site and return serialized cookies.
 * @throws if login fails or forum type is unsupported
 */
export async function loginToSite(domain: string, username: string, password: string): Promise<string> {
  const forumType = detectForumType(domain);
  const baseUrl = `https://${domain.replace(/^(https?:\/\/)?(www\.)?/, '')}`;

  switch (forumType) {
    case 'vbulletin':
      return loginVBulletin(baseUrl.includes('www.') ? baseUrl : baseUrl.replace('://', '://www.'), username, password);
    case 'xenforo': {
      let xfBase = baseUrl.includes('www.') ? baseUrl : baseUrl.replace('://', '://www.');
      // CGN runs XenForo under /forum/ path
      if (domain.toLowerCase().includes('canadiangunnutz.com')) {
        xfBase = `${xfBase}/forum`;
      }
      return loginXenForo(xfBase, username, password);
    }
    default:
      throw new Error(`Unsupported forum type for domain: ${domain}. Currently supported: Canadian Gun Nutz, Gun Owners of Canada.`);
  }
}

/**
 * Check if existing cookies are still valid by fetching the site and looking for login indicators.
 */
export async function validateSession(domain: string, cookies: string): Promise<boolean> {
  try {
    const url = `https://www.${domain.replace(/^(https?:\/\/)?(www\.)?/, '')}`;
    const html = await fetchPage(url, cookies);
    const $ = cheerio.load(html);
    const htmlLower = $.html().toLowerCase();

    // If we see logout links, we're logged in
    if (
      $('a[href*="logout"]').length ||
      htmlLower.includes('log out') ||
      htmlLower.includes('sign out') ||
      $('[class*="logged-in"]').length ||
      $('[class*="userinfo"]').length
    ) {
      return true;
    }

    // If we see login form, session is expired
    if (
      htmlLower.includes('vb_login_username') ||
      ($('input[name="login"]').length && $('input[type="password"]').length)
    ) {
      return false;
    }

    // Ambiguous — assume valid
    return true;
  } catch {
    return false;
  }
}
