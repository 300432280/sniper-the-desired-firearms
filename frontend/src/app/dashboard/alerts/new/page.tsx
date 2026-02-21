'use client';

import { useState } from 'react';
import Link from 'next/link';
import { searchesApi, credentialsApi, type Search, type Match, type SiteCredential } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

export default function NewAlertPage() {
  const { user } = useAuth();

  const [keyword, setKeyword] = useState('');
  const [websiteUrls, setWebsiteUrls] = useState<string[]>(['']);
  const [searchAll, setSearchAll] = useState(false);
  const [checkInterval, setCheckInterval] = useState(30);
  const [notificationType, setNotificationType] = useState<'EMAIL' | 'SMS' | 'BOTH'>('EMAIL');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [maxPrice, setMaxPrice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ searches: Search[]; matches: Match[]; loginRequired?: boolean; searchAllGroupId?: string; siteCount?: number } | null>(null);

  // Site login (for forums requiring authentication)
  const [needsLogin, setNeedsLogin] = useState(false);
  const [siteUsername, setSiteUsername] = useState('');
  const [sitePassword, setSitePassword] = useState('');
  const [savedCredentials, setSavedCredentials] = useState<SiteCredential[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);

  const isPro = user?.tier === 'PRO' || user?.isAdmin;

  const FORUM_DOMAINS = ['canadiangunnutz.com', 'gunownersofcanada.ca'];
  const hasForumUrl = websiteUrls.some((u) =>
    FORUM_DOMAINS.some((d) => u.toLowerCase().includes(d))
  );

  const addUrl = () => {
    if (websiteUrls.length < 10) setWebsiteUrls([...websiteUrls, '']);
  };

  const removeUrl = (index: number) => {
    if (websiteUrls.length > 1) setWebsiteUrls(websiteUrls.filter((_, i) => i !== index));
  };

  const updateUrl = (index: number, value: string) => {
    // Auto-split if user types or pastes comma/newline-separated URLs
    const parts = value.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const before = websiteUrls.slice(0, index);
      const after = websiteUrls.slice(index + 1);
      setWebsiteUrls([...before, ...parts, ...after].slice(0, 10));
      return;
    }
    setWebsiteUrls(websiteUrls.map((u, i) => (i === index ? value : u)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (searchAll) {
        // Search All Sites mode — no URLs needed
        const data = await searchesApi.createAuth({
          keyword,
          checkInterval,
          notificationType,
          inStockOnly,
          maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
          searchAll: true,
        });
        setResults(data);
      } else {
        // Normal mode — normalize URLs
        const normalizedUrls = websiteUrls
          .map((u) => u.trim())
          .filter((u) => u.length > 0)
          .map((u) => {
            if (/^https?:\/\//i.test(u)) return u;
            if (/^localhost(:\d+)?/i.test(u) || /^127\.0\.0\.1/i.test(u)) return `http://${u}`;
            return `https://${u}`;
          });

        if (normalizedUrls.length === 0) {
          setError('At least one URL is required');
          setLoading(false);
          return;
        }

        // If user provided site login credentials, save them first
        let credentialId: string | undefined;
        if (needsLogin && siteUsername && sitePassword) {
          const firstUrl = normalizedUrls[0];
          let domain: string;
          try {
            domain = new URL(firstUrl).hostname.replace(/^www\./, '');
          } catch {
            domain = firstUrl.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
          }
          const { credential } = await credentialsApi.create({
            domain,
            username: siteUsername,
            password: sitePassword,
          });
          credentialId = credential.id;
        } else if (selectedCredentialId) {
          credentialId = selectedCredentialId;
        }

        const data = await searchesApi.createAuth({
          websiteUrls: normalizedUrls,
          keyword,
          checkInterval,
          notificationType,
          inStockOnly,
          maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
          credentialId,
        });
        setResults(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert');
    } finally {
      setLoading(false);
    }
  };

  // ── Results view ──────────────────────────────────────────────────────────
  if (results) {
    const isSearchAll = !!results.searchAllGroupId;

    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
        <div className="card border border-accent/30 text-center py-8 mb-6">
          <div className="text-4xl text-accent mb-3 font-heading">&#10003;</div>
          <h2 className="font-heading text-2xl tracking-widest mb-2">
            {isSearchAll
              ? `Searching ${results.siteCount} Sites`
              : `${results.searches.length} Alert${results.searches.length !== 1 ? 's' : ''} Created`
            }
          </h2>
          <p className="text-foreground-muted text-sm">
            {isSearchAll ? (
              <>
                Monitoring &ldquo;<span className="text-foreground font-medium">{keyword}</span>&rdquo;
                {' '}across all Canadian sites. Results will arrive as each site is scanned.
              </>
            ) : (
              <>
                Monitoring &ldquo;<span className="text-foreground font-medium">{keyword}</span>&rdquo;
                {' '}&mdash; found {results.matches.length} initial match{results.matches.length !== 1 ? 'es' : ''}.
              </>
            )}
          </p>
        </div>

        {results.loginRequired && (
          <div className="border border-orange-500/30 bg-orange-500/5 px-4 py-3 mb-6">
            <p className="text-sm text-orange-400 font-heading tracking-wider uppercase mb-1">Login Required</p>
            <p className="text-xs text-foreground-muted">
              This site requires authentication to view listings. Enable &ldquo;Site Login&rdquo; and provide your forum
              credentials so the scraper can access protected content. Without login, results will be limited or empty.
            </p>
          </div>
        )}

        {!isSearchAll && results.searches.map((s) => {
          const searchMatches = results.matches.filter((m) => m.searchId === s.id);
          return (
            <div key={s.id} className="mb-5">
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2 truncate">
                {s.websiteUrl}
              </p>
              {searchMatches.length > 0 ? (
                <div className="space-y-1.5">
                  {searchMatches.map((m) => (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="card flex items-center justify-between hover:border-accent/30 transition-colors"
                    >
                      <div className="min-w-0 flex-1 flex items-center gap-3">
                        {m.thumbnail && (
                          <img
                            src={m.thumbnail}
                            alt=""
                            className="w-12 h-12 object-cover border border-border/50 flex-shrink-0"
                            loading="lazy"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{m.title}</p>
                          <div className="flex items-center gap-2">
                            {m.price != null && (
                              <span className="text-xs text-accent font-mono">${m.price}</span>
                            )}
                            {m.seller && (
                              <span className="text-[10px] text-foreground-dim">{m.seller}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <svg className="w-4 h-4 text-foreground-muted flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeWidth="1.5" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                      </svg>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="card text-center py-6">
                  <p className="text-foreground-muted text-sm">No matches yet &mdash; we&apos;ll notify you when something appears.</p>
                </div>
              )}
            </div>
          );
        })}

        <div className="flex gap-3 mt-6">
          <Link href="/dashboard" className="btn-primary flex-1 text-center">
            View Dashboard
          </Link>
          <button
            onClick={() => {
              setResults(null);
              setKeyword('');
              setWebsiteUrls(['']);
              setSearchAll(false);
              setMaxPrice('');
              setNeedsLogin(false);
              setSiteUsername('');
              setSitePassword('');
              setSelectedCredentialId(null);
            }}
            className="btn-secondary"
          >
            Create Another
          </button>
        </div>
      </div>
    );
  }

  // ── Form view ─────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/dashboard"
          className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted hover:text-foreground transition-colors flex items-center gap-2 mb-4"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </Link>
        <p className="text-[10px] font-heading tracking-[0.25em] text-secondary uppercase mb-1.5">
          New Alert
        </p>
        <h1 className="font-heading text-4xl tracking-wider">Configure Alert</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* Core fields */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Target
          </h2>

          <div>
            <label className="label">Search Keyword</label>
            <input
              type="text"
              className="input-field"
              placeholder='e.g. SKS rifle, AR-15 lower, 9mm 115gr'
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              required
              minLength={2}
              maxLength={100}
            />
          </div>

          {/* Search All Sites toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-heading tracking-wider">Search All Canadian Sites</div>
              <p className="text-xs text-foreground-muted">Monitor 80+ retailers, auctions, forums, and classifieds at once</p>
            </div>
            <button
              type="button"
              onClick={() => setSearchAll((v) => !v)}
              className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                searchAll ? 'bg-accent' : 'bg-surface-elevated border border-border-strong'
              }`}
            >
              <span
                className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                  searchAll ? 'translate-x-[21px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>

          {searchAll ? (
            <div className="border border-accent/20 bg-accent-subtle/30 px-4 py-3">
              <p className="text-xs text-foreground-muted">
                Your keyword will be searched across all enabled monitored sites. Results will be collected asynchronously
                and you&apos;ll be notified as matches are found.
              </p>
            </div>
          ) : (
            <div>
              <label className="label">URLs to Monitor</label>
              <div className="space-y-2">
                {websiteUrls.map((url, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      className="input-field flex-1"
                      placeholder="www.ellwoodepps.com/collections/rifles"
                      value={url}
                      onChange={(e) => updateUrl(i, e.target.value)}
                      required
                    />
                    {websiteUrls.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeUrl(i)}
                        className="px-3 border border-border text-foreground-muted hover:border-secondary/30 hover:text-secondary transition-colors text-sm"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {websiteUrls.length < 10 && (
                <button
                  type="button"
                  onClick={addUrl}
                  className="mt-2 text-xs font-heading tracking-wider text-accent hover:text-foreground transition-colors"
                >
                  + Add Another URL
                </button>
              )}
              <p className="mt-1 text-xs text-foreground-dim">
                Retailers, classifieds, forums, or auction sites. Paste comma-separated URLs to add multiple at once.
              </p>
              {hasForumUrl && !needsLogin && (
                <p className="mt-2 text-xs text-orange-400">
                  Forum URL detected &mdash; enable &ldquo;Site Login&rdquo; below to access members-only listings.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Notification settings */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Notifications
          </h2>

          <div>
            <label className="label">Check Interval</label>
            <div className={`grid gap-2 ${user?.isAdmin ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {([...(user?.isAdmin ? [0] : []), 5, 30, 60] as number[]).map((interval) => {
                const locked = interval === 5 && !isPro;
                const isTestMode = interval === 0;
                return (
                  <button
                    key={interval}
                    type="button"
                    disabled={locked}
                    onClick={() => !locked && setCheckInterval(interval)}
                    className={`py-2 text-sm font-heading tracking-wider uppercase border transition-colors
                      ${checkInterval === interval && !locked
                        ? isTestMode
                          ? 'border-orange-500 bg-orange-500/10 text-orange-400'
                          : 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-strong text-foreground-muted hover:border-accent/30'
                      }
                      ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    {interval === 0 ? '10 Sec' : interval === 5 ? '5 Min' : interval === 30 ? '30 Min' : '1 Hour'}
                    {isTestMode && (
                      <span className="block text-[9px] tracking-widest text-orange-500 normal-case mt-0.5">
                        Test
                      </span>
                    )}
                    {locked && (
                      <span className="block text-[9px] tracking-widest text-foreground-dim normal-case mt-0.5">
                        Pro
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label">Notify Via</label>
            <div className="grid grid-cols-3 gap-2">
              {(['EMAIL', 'SMS', 'BOTH'] as const).map((type) => {
                const locked = (type === 'SMS' || type === 'BOTH') && !isPro;
                return (
                  <button
                    key={type}
                    type="button"
                    disabled={locked}
                    onClick={() => !locked && setNotificationType(type)}
                    className={`py-2 text-sm font-heading tracking-wider uppercase border transition-colors
                      ${notificationType === type && !locked
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-strong text-foreground-muted hover:border-accent/30'
                      }
                      ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    {type}
                    {locked && (
                      <span className="block text-[9px] tracking-widest text-foreground-dim normal-case mt-0.5">
                        Pro
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {(notificationType === 'SMS' || notificationType === 'BOTH') && !user?.phone && (
              <p className="mt-2 text-xs text-secondary">
                No phone number on file.{' '}
                <Link href="/dashboard/settings" className="underline hover:text-foreground">
                  Add one in settings
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Filters <span className="font-normal normal-case text-xs text-foreground-dim">(optional)</span>
          </h2>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-heading tracking-wider">In-Stock Only</div>
              <p className="text-xs text-foreground-muted">Only alert when item shows as available</p>
            </div>
            <button
              type="button"
              onClick={() => setInStockOnly((v) => !v)}
              className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                inStockOnly ? 'bg-accent' : 'bg-surface-elevated border border-border-strong'
              }`}
            >
              <span
                className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                  inStockOnly ? 'translate-x-[21px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>

          <div>
            <label className="label">Maximum Price (CAD)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm font-mono">
                $
              </span>
              <input
                type="number"
                className="input-field pl-7"
                placeholder="e.g. 1500"
                min="0"
                step="0.01"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
              />
            </div>
            <p className="mt-1 text-xs text-foreground-dim">
              Leave empty to alert at any price.
            </p>
          </div>
        </div>

        {/* Site Login (for forums/members-only sites) */}
        <div className="card space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted">
                Site Login <span className="font-normal normal-case text-xs text-foreground-dim">(optional)</span>
              </h2>
              <p className="text-xs text-foreground-muted mt-1">For forums or members-only sites that require authentication</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                const next = !needsLogin;
                setNeedsLogin(next);
                if (next && savedCredentials.length === 0) {
                  try {
                    const { credentials } = await credentialsApi.list();
                    setSavedCredentials(credentials);
                  } catch { /* ignore */ }
                }
              }}
              className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                needsLogin ? 'bg-accent' : 'bg-surface-elevated border border-border-strong'
              }`}
            >
              <span
                className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                  needsLogin ? 'translate-x-[21px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </div>

          {needsLogin && (
            <div className="space-y-4 border-t border-border pt-4">
              {/* Saved credentials selector */}
              {savedCredentials.length > 0 && (
                <div>
                  <label className="label">Use Saved Credential</label>
                  <select
                    className="input-field"
                    value={selectedCredentialId || ''}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      setSelectedCredentialId(id);
                      if (id) {
                        setSiteUsername('');
                        setSitePassword('');
                      }
                    }}
                  >
                    <option value="">Enter new credentials</option>
                    {savedCredentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.domain} ({c.username})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* New credentials form */}
              {!selectedCredentialId && (
                <>
                  <div>
                    <label className="label">Site Username</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="Your forum username"
                      value={siteUsername}
                      onChange={(e) => setSiteUsername(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label">Site Password</label>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="Your forum password"
                      value={sitePassword}
                      onChange={(e) => setSitePassword(e.target.value)}
                    />
                  </div>
                  <p className="text-[10px] text-foreground-dim leading-relaxed">
                    Credentials are encrypted with AES-256-GCM before storage. They are only used to authenticate with the
                    target forum for scanning. Supported: Canadian Gun Nutz, Gun Owners of Canada.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="border border-secondary/30 bg-secondary-subtle text-secondary px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="btn-primary flex-1"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
                {searchAll ? 'Creating alerts...' : 'Scanning...'}
              </span>
            ) : (
              searchAll ? 'Search All Sites' : 'Create Alert'
            )}
          </button>
          <Link href="/dashboard" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
