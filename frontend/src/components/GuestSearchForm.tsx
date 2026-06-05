'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { searchesApi, type LiveSearchResult } from '@/lib/api';

interface Props {
  defaultKeyword?: string;
}

const PAGE_SIZE = 20;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

// Windowed page list with ellipsis. Page 1 and the last page are always shown
// (they double as jump-to-first / jump-to-last), with current ±1 in between.
// e.g. (current=7, total=20) → [1, '…', 6, 7, 8, '…', 20].
function pageRange(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push('…');
  for (let p = start; p <= end; p++) items.push(p);
  if (end < total - 1) items.push('…');
  items.push(total);
  return items;
}

type SortBy = 'newest' | 'updated' | 'price_asc' | 'price_desc';
type StockFilter = 'all' | 'in' | 'out';
type AmmoFilter = 'include' | 'exclude';
// Classifieds carry buy-requests ("wanted"/WTB/ISO) alongside for-sale listings.
// `category === 'wanted'` flags a buy-request; everything else is a sale listing.
type AdType = 'sale' | 'wanted' | 'all';

interface Filters {
  sortBy: SortBy;
  stock: StockFilter;
  ammo: AmmoFilter;
  adType: AdType;
  minPrice: string;
  maxPrice: string;
}

const DEFAULT_FILTERS: Filters = {
  sortBy: 'newest',
  stock: 'all',
  ammo: 'include',
  adType: 'sale',
  minPrice: '',
  maxPrice: '',
};

export default function GuestSearchForm({ defaultKeyword = '' }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // A SUBMITTED search is reflected in the URL (?q=…). A fresh main-page visit has
  // no ?q= → clean landing, no auto-search. After the user submits, the URL holds
  // ?q=, so a refresh restores it and re-runs the search — keeping the user on the
  // results page instead of bouncing back to the empty landing form.
  const initialQuery = searchParams.get('q') ?? defaultKeyword;
  const [keyword, setKeyword] = useState(initialQuery);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // The FULL keyword-matched set from the last fetch. Filtering/sorting/paging
  // happen client-side over this — a filter toggle never hits the network.
  const [allResults, setAllResults] = useState<LiveSearchResult[]>([]);
  // The keyword that produced `allResults` (so the header reflects what was
  // searched, not what the user is mid-typing).
  const [searchedKeyword, setSearchedKeyword] = useState('');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [showNotify, setShowNotify] = useState(false);

  const resultsRef = useRef<HTMLDivElement>(null);
  // Guards the SEO-page mount auto-run so it fires at most once.
  const didAutoRun = useRef(false);

  // Fetch the full matched set for a keyword. Called ONLY on an explicit search
  // (Search button) or the SEO-page mount auto-run — NEVER on filter changes,
  // pagination, or page refresh.
  const runSearch = async (term: string) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;

    setStatus('loading');
    setErrorMsg('');
    try {
      const data = await searchesApi.liveSearch({ keyword: trimmed, searchAll: true });
      setAllResults(data.results);
      setSearchedKeyword(trimmed);
      setPage(1);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Search failed');
      setStatus('error');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyword.trim();
    if (trimmed.length < 2) return;
    // Reflect the submitted search in the URL so a refresh restores the results
    // page. router.replace (not push) avoids piling up history entries per search.
    router.replace(`${pathname}?q=${encodeURIComponent(trimmed)}`);
    runSearch(trimmed);
  };

  // Client-side filter + sort over the fetched set. Recomputed instantly when a
  // filter changes — zero network, zero DB. This is why filter toggles are fast.
  const filtered = useMemo(() => {
    const min = filters.minPrice.trim() === '' ? null : Number(filters.minPrice);
    const max = filters.maxPrice.trim() === '' ? null : Number(filters.maxPrice);

    const out = allResults.filter((r) => {
      if (filters.adType === 'sale' && r.category === 'wanted') return false;
      if (filters.adType === 'wanted' && r.category !== 'wanted') return false;
      if (filters.stock === 'in' && r.stockStatus !== 'in_stock') return false;
      if (filters.stock === 'out' && r.stockStatus !== 'out_of_stock') return false;
      if (filters.ammo === 'exclude' && r.productType === 'ammunition') return false;
      // A null-price product can't satisfy a price bound.
      if (min != null && !Number.isNaN(min) && !(r.price != null && r.price >= min)) return false;
      if (max != null && !Number.isNaN(max) && !(r.price != null && r.price <= max)) return false;
      return true;
    });

    // NULL prices sort last in both directions.
    const byPriceAsc = (a: LiveSearchResult, b: LiveSearchResult) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    };
    switch (filters.sortBy) {
      case 'price_asc':
        out.sort(byPriceAsc);
        break;
      case 'price_desc':
        out.sort((a, b) => -byPriceAsc(a, b));
        break;
      case 'updated':
        out.sort((a, b) => new Date(b.contentChangedAt).getTime() - new Date(a.contentChangedAt).getTime());
        break;
      case 'newest':
        out.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());
        break;
    }
    return out;
  }, [allResults, filters]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageResults = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  // If a filter shrank the set below the current page, snap back into range.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Apply a filter and return to page 1. No fetch — `filtered` recomputes.
  const applyFilter = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const goToPage = (next: number) => {
    if (next < 1 || next > totalPages || next === page) return;
    setPage(next);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // On mount, restore a previously-submitted search from the URL (?q=) and re-run
  // it — this is what keeps a results-page refresh on the results page. SEO pages
  // (/alerts/[slug]) pass `defaultKeyword`, also captured in initialQuery, and
  // auto-run the same way. A fresh main-page visit has neither → clean landing,
  // no auto-search (only the Search button initiates a brand-new search).
  useEffect(() => {
    if (didAutoRun.current) return;
    didAutoRun.current = true;
    if (initialQuery.trim().length >= 2) runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loading = status === 'loading';
  const hasSearched = status === 'done' || (status === 'loading' && searchedKeyword !== '');

  return (
    <div className="card space-y-6">
      {/* ── Search row ───────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <label htmlFor="live-search-keyword" className="sr-only">
            Search keyword
          </label>
          <input
            id="live-search-keyword"
            className="input-field"
            type="text"
            placeholder="Search rifles, ammo, optics…"
            aria-label="Search keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            minLength={2}
            maxLength={100}
            autoComplete="off"
          />
        </div>
        <button
          type="submit"
          disabled={loading || keyword.trim().length < 2}
          className="btn-primary sm:w-auto"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
              Searching...
            </span>
          ) : (
            'Search'
          )}
        </button>
      </form>

      {status === 'error' && (
        <p className="text-secondary text-sm border border-secondary/20 bg-secondary-subtle px-3 py-2">
          {errorMsg}
        </p>
      )}

      {/* ── Results ──────────────────────────────────────────────────── */}
      {hasSearched && (
        <div ref={resultsRef} className="space-y-4 animate-fade-in">
          <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
            {total} result{total !== 1 ? 's' : ''} for{' '}
            <span className="text-foreground">&ldquo;{searchedKeyword}&rdquo;</span>
          </p>

          {/* ── Filter bar (all client-side → instant) ─────────────── */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Sort results"
              value={filters.sortBy}
              onChange={(e) => applyFilter({ sortBy: e.target.value as SortBy })}
              className="input-field w-auto py-1.5 text-xs"
            >
              <option value="newest">Newest</option>
              <option value="updated">Recently updated</option>
              <option value="price_asc">Price: Low &rarr; High</option>
              <option value="price_desc">Price: High &rarr; Low</option>
            </select>

            <select
              aria-label="Stock filter"
              value={filters.stock}
              onChange={(e) => applyFilter({ stock: e.target.value as StockFilter })}
              className="input-field w-auto py-1.5 text-xs"
            >
              <option value="all">All</option>
              <option value="in">In stock</option>
              <option value="out">Out of stock</option>
            </select>

            <select
              aria-label="Ad type"
              value={filters.adType}
              onChange={(e) => applyFilter({ adType: e.target.value as AdType })}
              className="input-field w-auto py-1.5 text-xs"
            >
              <option value="sale">For sale</option>
              <option value="wanted">Wanted ads</option>
              <option value="all">All ads</option>
            </select>

            <label className="inline-flex items-center gap-1.5 text-foreground-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filters.ammo === 'include'}
                onChange={(e) => applyFilter({ ammo: e.target.checked ? 'include' : 'exclude' })}
                className="accent-accent"
              />
              Include ammo
            </label>

            <input
              type="number"
              inputMode="numeric"
              min={0}
              aria-label="Minimum price"
              placeholder="Min $"
              value={filters.minPrice}
              onChange={(e) => applyFilter({ minPrice: e.target.value })}
              className="input-field w-20 py-1.5 text-xs"
            />
            <input
              type="number"
              inputMode="numeric"
              min={0}
              aria-label="Maximum price"
              placeholder="Max $"
              value={filters.maxPrice}
              onChange={(e) => applyFilter({ maxPrice: e.target.value })}
              className="input-field w-20 py-1.5 text-xs"
            />
          </div>

          {total === 0 ? (
            <p className="text-sm text-foreground-muted leading-relaxed">
              No matches found for{' '}
              <span className="text-foreground">&ldquo;{searchedKeyword}&rdquo;</span>. Try a
              different term.
            </p>
          ) : (
            <div className="space-y-1.5">
              {pageResults.map((r) => {
                const host = hostOf(r.url);
                const updated = relativeTime(r.contentChangedAt);
                return (
                  <a
                    key={r.url}
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 border border-border hover:border-accent/30 transition-colors px-3 py-2.5"
                  >
                    {r.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.thumbnail}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        className="w-12 h-12 flex-shrink-0 object-cover border border-border bg-surface-elevated"
                      />
                    ) : (
                      <span className="w-12 h-12 flex-shrink-0 border border-border bg-surface-elevated" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{r.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {host && (
                          <span className="text-[11px] text-foreground-dim truncate">{host}</span>
                        )}
                        {r.stockStatus === 'in_stock' && (
                          <span className="text-[10px] font-heading tracking-wider uppercase text-accent border border-accent/20 px-1.5 py-0.5">
                            In stock
                          </span>
                        )}
                        {r.stockStatus === 'out_of_stock' && (
                          <span className="text-[10px] font-heading tracking-wider uppercase text-foreground-muted border border-border px-1.5 py-0.5">
                            Out of stock
                          </span>
                        )}
                        {updated && (
                          <span className="text-[11px] text-foreground-dim tabular-nums">
                            updated {updated} ago
                          </span>
                        )}
                      </div>
                    </div>

                    {r.price != null && (
                      <p className="flex-shrink-0 text-sm text-accent font-mono tabular-nums">
                        ${r.price}
                      </p>
                    )}
                  </a>
                );
              })}
            </div>
          )}

          {/* ── Pagination (windowed numbered buttons) ─────────────── */}
          {totalPages > 1 && (
            <nav
              aria-label="Search results pages"
              className="flex flex-wrap items-center justify-center gap-1.5 pt-2"
            >
              <button
                type="button"
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
                className="btn-secondary text-xs px-3 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>

              {pageRange(page, totalPages).map((item, i) =>
                item === '…' ? (
                  <span
                    key={`gap-${i}`}
                    aria-hidden="true"
                    className="px-1.5 text-xs text-foreground-dim select-none"
                  >
                    &hellip;
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => goToPage(item)}
                    aria-label={`Page ${item}`}
                    aria-current={item === page ? 'page' : undefined}
                    className={
                      item === page
                        ? 'text-xs px-3 py-2 border border-accent bg-accent-subtle text-accent font-heading tabular-nums'
                        : 'btn-secondary text-xs px-3 py-2 tabular-nums'
                    }
                  >
                    {item}
                  </button>
                ),
              )}

              <button
                type="button"
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages}
                aria-label="Next page"
                className="btn-secondary text-xs px-3 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </nav>
          )}

          {/* ── Notifications (deferred / progressive disclosure) ──── */}
          <div className="pt-4 border-t border-border">
            {!showNotify ? (
              <button
                type="button"
                onClick={() => setShowNotify(true)}
                className="text-xs text-foreground-muted hover:text-foreground transition-colors"
              >
                Get alerted when new matches appear
              </button>
            ) : (
              <div className="space-y-2 animate-fade-in">
                <p className="text-xs text-foreground-muted leading-relaxed">
                  Want to be notified when new matches show up? That feature is coming soon.
                </p>
                <a
                  href="/register"
                  className="inline-block text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  Create a free account to set up alerts across all sites &rarr;
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
