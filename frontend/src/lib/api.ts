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
  websiteUrl: string;
  checkInterval: number;
  notificationType: 'EMAIL' | 'SMS' | 'BOTH';
  inStockOnly: boolean;
  maxPrice?: number;
};

export const searchesApi = {
  list: () => request<{ searches: Search[] }>('GET', '/searches'),

  get: (id: string) =>
    request<{ search: Search & { matches: Match[] } }>('GET', `/searches/${id}`),

  createGuest: (data: CreateGuestSearch) =>
    request<{ search: Search }>('POST', '/searches', data),

  createAuth: (data: CreateAuthSearch) =>
    request<{ search: Search }>('POST', '/searches', data),

  delete: (id: string) => request<{ message: string }>('DELETE', `/searches/${id}`),

  toggle: (id: string) => request<{ search: Search }>('PATCH', `/searches/${id}/toggle`),

  matches: (searchId: string) =>
    request<{ matches: Match[] }>('GET', `/searches/matches/${searchId}`),
};
