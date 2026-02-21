/** Resolve a relative href against a base URL */
export function resolveUrl(href: string, baseUrl: string): string {
  try {
    if (!href || href === '#') return baseUrl;
    if (href.startsWith('http')) return href;
    // .aspx relative paths (e.g. "LotDetail.aspx?id=123") should resolve from origin root
    if (/^[a-zA-Z][\w-]*\.aspx/i.test(href)) {
      const origin = new URL(baseUrl).origin;
      return `${origin}/${href}`;
    }
    return new URL(href, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

/** Check whether a URL is just a bare domain with no path or query */
export function isBareDomain(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && !u.search;
  } catch {
    return false;
  }
}

/** Strip www. prefix from a hostname for normalization */
export function normalizeDomain(hostname: string): string {
  return hostname.replace(/^www\./, '').toLowerCase();
}
