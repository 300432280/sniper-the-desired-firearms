// All API calls go through this typed client.
// The Next.js rewrite in next.config.ts proxies /api/* → Express backend,
// so cookies work as same-origin requests.

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include', // Send httpOnly cookies with every request
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(
      typeof err.error === 'string' ? err.error : JSON.stringify(err.error)
    );
  }

  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  tier: 'FREE' | 'PRO';
  phone?: string | null;
  isAdmin?: boolean;
}

export interface Search {
  id: string;
  userId?: string | null;
  keyword: string;
  websiteUrl: string;
  checkInterval: number;
  notificationType: 'EMAIL' | 'SMS' | 'BOTH';
  isActive: boolean;
  inStockOnly: boolean;
  maxPrice?: number | null;
  lastChecked?: string | null;
  lastMatchHash?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  searchAllGroupId?: string | null;
  _count?: { matches: number };
}

export interface Match {
  id: string;
  searchId: string;
  title: string;
  price?: number | null;
  url: string;
  hash: string;
  foundAt: string;
  thumbnail?: string | null;
  postDate?: string | null;
  seller?: string | null;
}

export interface LiveMatch {
  title: string;
  price?: number;
  url: string;
  inStock?: boolean;
  isNew?: boolean;
  thumbnail?: string;
  seller?: string;
}

export interface ScanResult {
  matches: LiveMatch[];
  scrapedAt: string;
  newCount: number;
  totalDbMatches: number;
  notificationId: string | null;
}

export interface SiteCredential {
  id: string;
  domain: string;
  username: string;
  lastLogin?: string | null;
  createdAt?: string;
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

export const authApi = {
  register: (data: { email: string; password: string; phone?: string }) =>
    request<{ user: User }>('POST', '/auth/register', data),

  login: (data: { email: string; password: string }) =>
    request<{ user: User }>('POST', '/auth/login', data),

  logout: () => request<{ message: string }>('POST', '/auth/logout', {}),

  me: () => request<{ user: User | null }>('GET', '/auth/me'),

  updateProfile: (data: { phone?: string | null }) =>
    request<{ user: User }>('PATCH', '/auth/profile', data),
};

// ─── Searches API ─────────────────────────────────────────────────────────────

export type CreateGuestSearch = {
  keyword: string;
  websiteUrl: string;
  notifyEmail: string;
};

export type CreateAuthSearch = {
  keyword: string;
  websiteUrls?: string[];
  checkInterval: number;
  notificationType: 'EMAIL' | 'SMS' | 'BOTH';
  inStockOnly: boolean;
  maxPrice?: number;
  credentialId?: string;
  searchAll?: boolean;
};

export interface SearchAllGroupResult {
  groupId: string;
  keyword: string;
  siteCount: number;
  sitesWithMatches: number;
  totalMatches: number;
  matches: (Match & { websiteUrl: string })[];
  searches: {
    id: string;
    websiteUrl: string;
    matchCount: number;
    lastChecked: string | null;
    isActive: boolean;
  }[];
}

export interface MonitoredSite {
  id: string;
  domain: string;
  name: string;
  url: string;
  siteType: string;
  adapterType: string;
  isEnabled: boolean;
  requiresSucuri: boolean;
  requiresAuth: boolean;
  searchUrlPattern?: string | null;
  notes?: string | null;
  healthChecks?: Array<{
    isReachable: boolean;
    canScrape: boolean;
    responseTimeMs: number | null;
    errorMessage: string | null;
    checkedAt: string;
  }>;
}

export interface HealthSummary {
  sites: Array<{
    id: string;
    domain: string;
    name: string;
    siteType: string;
    isEnabled: boolean;
    lastCheck: {
      isReachable: boolean;
      canScrape: boolean;
      responseTimeMs: number | null;
      errorMessage: string | null;
      checkedAt: string;
    } | null;
  }>;
}

export const searchesApi = {
  list: () => request<{ searches: Search[] }>('GET', '/searches'),

  get: (id: string) =>
    request<{ search: Search & { matches: Match[] } }>('GET', `/searches/${id}`),

  createGuest: (data: CreateGuestSearch) =>
    request<{ search: Search; matches: Match[] }>('POST', '/searches', data),

  createAuth: (data: CreateAuthSearch) =>
    request<{ searches: Search[]; matches: Match[]; searchAllGroupId?: string; siteCount?: number }>('POST', '/searches', data),

  delete: (id: string) => request<{ message: string }>('DELETE', `/searches/${id}`),

  toggle: (id: string) => request<{ search: Search }>('PATCH', `/searches/${id}/toggle`),

  matches: (searchId: string) =>
    request<{ matches: Match[] }>('GET', `/searches/matches/${searchId}`),

  scanNow: (id: string) =>
    request<ScanResult>('POST', `/searches/${id}/scan`),

  getGroup: (groupId: string) =>
    request<SearchAllGroupResult>('GET', `/searches/group/${groupId}`),

  deleteGroup: (groupId: string) =>
    request<{ message: string }>('DELETE', `/searches/group/${groupId}`),

  toggleGroup: (groupId: string) =>
    request<{ isActive: boolean; count: number }>('PATCH', `/searches/group/${groupId}/toggle`),

  scanGroup: (groupId: string) =>
    request<{ scannedSites: number; successCount: number; failCount: number; totalMatches: number; matches: (LiveMatch & { websiteUrl?: string })[] }>(
      'POST', `/searches/group/${groupId}/scan`
    ),
};

// ─── Credentials API ─────────────────────────────────────────────────────────

export const credentialsApi = {
  list: () =>
    request<{ credentials: SiteCredential[] }>('GET', '/searches/credentials'),

  create: (data: { domain: string; username: string; password: string }) =>
    request<{ credential: SiteCredential }>('POST', '/searches/credentials', data),

  delete: (id: string) =>
    request<{ message: string }>('DELETE', `/searches/credentials/${id}`),
};

// ─── Admin API ────────────────────────────────────────────────────────────────

export const sitesApi = {
  list: () =>
    request<{ sites: MonitoredSite[] }>('GET', '/admin/sites'),

  create: (data: Partial<MonitoredSite>) =>
    request<{ site: MonitoredSite }>('POST', '/admin/sites', data),

  update: (id: string, data: Partial<MonitoredSite>) =>
    request<{ site: MonitoredSite }>('PATCH', `/admin/sites/${id}`, data),

  delete: (id: string) =>
    request<{ success: boolean }>('DELETE', `/admin/sites/${id}`),

  test: (id: string, keyword?: string) =>
    request<{ site: { id: string; domain: string; name: string }; keyword: string; adapterUsed: string; matchCount: number; matches: LiveMatch[]; loginRequired: boolean; errors?: string[] }>(
      'POST', `/admin/sites/${id}/test`, { keyword }
    ),
};

export const healthApi = {
  summary: () =>
    request<HealthSummary>('GET', '/admin/health'),

  run: () =>
    request<{ total: number; reachable: number; canScrape: number; failed: any[] }>('POST', '/admin/health/run'),

  prune: () =>
    request<{ deleted: number }>('POST', '/admin/health/prune'),
};
