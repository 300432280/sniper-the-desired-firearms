/**
 * Keyword Matcher — matches new ProductIndex entries against active Searches.
 *
 * When a new product is added to ProductIndex:
 * 1. Expand each active Search keyword via KeywordAlias → get all variations
 * 2. Check if product title contains any alias (word-boundary match)
 * 3. If match → create Match record → trigger notification per user tier
 *
 * When a user creates a new Search:
 * 1. Immediately query ProductIndex with alias expansion → return instant results
 */

import { prisma } from '../lib/prisma';
import { pushEvent } from './debugLog';

// Max ProductIndex rows fetched per searchProductIndex broad-ILIKE pass before
// JS refinement. A keyword×catalog combo that hits this cap is silently
// truncated (rows beyond the cap never reach the word-boundary refine step), so
// we warn + emit a debug event when it's reached.
//
// SCOPE: this cap binds the SITE-SCOPED path (siteIds provided). For a single
// site, 1000 newest matching rows is far more than any one catalog yields for a
// real keyword, so it effectively never truncates there — its purpose is purely
// a safety ceiling + observability for that path.
const SEARCH_INDEX_CAP = 1000;

// Per-site cap for the ALL-SITES global search path (siteIds undefined). The old
// single global `take: SEARCH_INDEX_CAP` ordered by firstSeenAt was UNFAIR: the
// 1000 newest matches cluster on a few high-volume sites, so other sites were
// squeezed to ~0 (measured 2026-06-05: "glock" surfaced 26/47 sites, "ammo" 8/49).
// Instead we fetch the newest PER_SITE_CAP matches PER maintain-site, so every
// site is represented and total rows are bounded at PER_SITE_CAP × (#sites).
//
// IMPORTANT: this cap bounds the BROAD (pre-refine) per-site SQL fetch, NOT the
// post-refine count. So the ceiling must sit ABOVE the busiest NORMAL keyword's
// per-site BROAD row count, or that site would be truncated before refinement
// and return FEWER results than the old path. Measured per-site broad maxima
// (2026-06-05, busiest single site): glock 602, remington-870 432, tikka 1000,
// sako 413, cz 773, ruger 1518, savage 2035. 3000 clears the worst normal brand
// (savage 2035) with headroom, so no ordinary keyword is truncated.
//
// Bare CATEGORY words still exceed it on their biggest sites (per-site broad:
// ammo up to 37,609; rifle up to 18,893) and ARE truncated per-site — that is
// acceptable (those sets are paginated client-side) AND is surfaced by the
// PER_SITE_CAP observability below. At cap=3000 the worst bare-category search
// ("ammo") fetches ~30,106 broad rows total (vs 66,486 uncapped).
const PER_SITE_CAP = 3000;

// Bounded-concurrency map returning settled results. The all-sites path issues
// one indexed per-site query per maintain-site (~56); running them 8-at-a-time
// keeps Neon connection use sane while the siteId composite indexes make each
// query a cheap seek (vs the old single unindexed global scan+sort). Results are
// returned per input in order as {status:'fulfilled',value} | {status:'rejected',
// reason} so ONE site's query failure (a Neon hiccup) drops only that site
// instead of failing the entire 56-query search.
async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>> {
  const out: Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }> = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try {
        out[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
      } catch (reason) {
        out[idx] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// ── Alias Expansion ─────────────────────────────────────────────────────────

/**
 * Expand a keyword to all its aliases via KeywordGroup.
 * If no alias group exists, returns the raw keyword as-is.
 */
export async function expandKeyword(keyword: string): Promise<string[]> {
  const normalized = keyword.toLowerCase().trim();

  // Look up the keyword in aliases
  const alias = await prisma.keywordAlias.findUnique({
    where: { alias: normalized },
    include: { group: { include: { aliases: true } } },
  });

  if (alias) {
    return alias.group.aliases.map(a => a.alias);
  }

  // No group found — return raw keyword
  return [normalized];
}

// ── Word Boundary Matching ──────────────────────────────────────────────────

/**
 * Check if a keyword appears in a title as a standalone token (word boundary match).
 * "sks" matches "Russian SKS Rifle" but NOT "#SKS6336A40A9S0"
 *
 * Also handles space-collapsed matching:
 *   "tm 22" matches "TM22"    ✓  (spaces in keyword, no spaces in title)
 *   "tm22"  matches "TM 22"   ✓  (no spaces in keyword, spaces in title)
 */
export function matchesKeyword(title: string, keyword: string): boolean {
  if (matchesKeywordExact(title, keyword)) return true;

  // Normalize: treat spaces and hyphens as interchangeable in model names.
  // "ar-15", "ar 15", "ar15" should all match "AR-15", "AR 15", "AR15".
  const kwStripped = keyword.replace(/[\s\-]+/g, '');
  if (kwStripped !== keyword && matchesKeywordExact(title, kwStripped)) return true;

  // Build a flexible regex from the stripped keyword that allows optional
  // spaces/hyphens between each character, with a word boundary on the left.
  // "ar15" → /(?<![a-z0-9])a[\s\-]?r[\s\-]?1[\s\-]?5/i
  // Matches: "AR-15", "AR 15", "AR15"
  //
  // SHORT, PURELY-ALPHABETIC aliases ALSO get a RIGHT boundary so they don't
  // prefix-match into longer words. Longer aliases, and short aliases that
  // carry a digit/symbol model code ("g19", "ar15"), stay right-unbounded so
  // "glock" -> "Glock17" and "ar15" -> "AR15A4" model variants keep matching.
  // See isShortAlphaAlias and matchesKeywordExact for the rationale.
  if (kwStripped.length >= 3 && kwStripped.length <= 20) {
    const escaped = kwStripped.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-]?');
    const right = isShortAlphaAlias(kwStripped) ? '(?![a-z0-9])' : '';
    const re = new RegExp(`(?<![a-z0-9])${escaped}${right}`, 'i');
    if (re.test(title)) return true;
  }

  // Multi-word AND matching WITH a proximity constraint: every word must
  // appear AND the hits must fall within a small token window. Without the
  // window, the SKS-clone alias "type 56" matched
  // "NORINCO TYPE 97 NSR G3 .223/5.56 ..." because "type" (from TYPE 97) and
  // "56" (from the 5.56 caliber) each appear, far apart, in unrelated
  // positions. (2026-05-27 westernmetal.ca false positive.) The window keeps
  // legit brand+spec hits like "mauser 308" -> "Mauser K98 .308 Win".
  const words = keyword.split(/\s+/).filter(w => w.length >= 2);
  if (words.length >= 2 && wordsWithinProximity(title, words, words.length - 1 + PROXIMITY_SLACK)) {
    return true;
  }

  return false;
}

/**
 * Extra filler tokens allowed between the words of a multi-word keyword,
 * beyond the words themselves. N adjacent words have span N-1; we allow up to
 * PROXIMITY_SLACK additional tokens in the span. (e.g. 2 words -> span <= 2,
 * so "Mauser K98 .308" matches "mauser 308" but "TYPE 97 ... 5.56" does not
 * match "type 56" — its clean hits land 3+ tokens apart.)
 */
const PROXIMITY_SLACK = 1;

const SHORT_ALIAS_MAX = 3;

/**
 * A short alias is required to match as a COMPLETE token (left AND right word
 * boundary) — rather than the usual left-only prefix match — ONLY when it is
 * short (<= SHORT_ALIAS_MAX chars) AND purely alphabetic (letters only, no
 * digit, no symbol).
 *
 * Why purely-alphabetic: the false positives are short ALPHA aliases that
 * prefix a different WORD. A bare 3-char alias like "mag" (an alias of
 * "magazine") otherwise prefix-matches into "Magnum", "Magpul",
 * "Magnet/Magnetic", and SKUs like "MAG526-BLK". Measured live: 59% of 405
 * "magazine" hits on bullseyenorth came ONLY via this "mag" prefix collision
 * (Magpul SKUs, Magnum ammo, even a Morakniv).
 *
 * Why NOT digit/symbol short aliases: short aliases that carry a digit or
 * symbol are model codes whose prefix-into-VARIANT is desired and has no
 * alpha fallback: "g19" -> "Glock G19X", "g17" -> "Glock G17L", "m&p" ->
 * "S&W M&P9 Compact", ".45" -> ".45ACP". These keep right-unbounded matching.
 *
 * Longer aliases (>= 4 chars: "glock", "mauser", "german", "magazine") also
 * keep the right-unbounded prefix behavior so model/plural/variant suffixes
 * still match ("Glock17", "Mausers", "Germany").
 *
 * BY DESIGN, a bare purely-alpha short alias does NOT match a glued model
 * variant: "sks" does NOT match "SKS47". "SKS Rifle" still matches via the
 * space boundary, and "SKS-45" matches via the dedicated `sks-45` alias in the
 * SKS keyword group — but the glued "SKS47" form is intentionally excluded to
 * keep the "mag" FP fix simple and predictable. (2026-06-01 "mag" prefix FP;
 * pure-alpha refinement same day after m&p/g19/.45 false-negative review.)
 */
function isShortAlphaAlias(kw: string): boolean {
  return kw.length <= SHORT_ALIAS_MAX && /^[a-z]+$/i.test(kw);
}

/**
 * Stricter per-token match for the multi-word proximity branch. Builds on the
 * left-boundary prefix match (matchesKeywordExact) but rejects two spurious
 * sub-matches that caused false positives:
 *  - numeric component matching the fractional part of a decimal caliber
 *    ("56" in "5.56") — digit before the '.'.
 *  - short (<3 char) alpha component prefixing into a longer word ("tm" in
 *    "tmj") — require a clean right boundary.
 * Longer alpha components (rem, moss, sig...) keep prefix matching, and numeric
 * variant suffixes (92->92fs, 64->64f, 19->19x) are unaffected because those
 * match via the EXACT branch (contiguous "brand NN"), not this multiword path.
 */
function componentMatchesToken(token: string, word: string): boolean {
  const t = token.toLowerCase();
  const w = word.toLowerCase();
  const idx = t.indexOf(w);
  if (idx === -1) return false;
  const before = idx > 0 ? t[idx - 1] : ' ';
  if (/[a-z0-9]/i.test(before)) return false;          // left boundary (same as matchesKeywordExact)
  const after = idx + w.length < t.length ? t[idx + w.length] : '';
  // Rule 1: numeric component must not be a decimal fraction ("56" in "5.56").
  if (/^\d+$/.test(w) && before === '.') {
    const before2 = idx >= 2 ? t[idx - 2] : '';
    if (/[0-9]/.test(before2)) return false;
  }
  // Rule 2: short (<3) alpha component must be a complete run, not a prefix
  // into a longer alphanumeric token ("tm" in "tmj").
  if (/^[a-z]+$/i.test(w) && w.length < 3 && after && /[a-z0-9]/i.test(after)) return false;
  return true;
}

/**
 * True when every word in `words` matches some token in `text` AND a single
 * window of at most `window` tokens covers at least one hit for every word.
 * Uses componentMatchesToken per token, then a sliding window over the sorted
 * hits (classic "smallest range covering K lists").
 */
function wordsWithinProximity(text: string, words: string[], window: number): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  const hits: Array<{ pos: number; word: number }> = [];
  for (let w = 0; w < words.length; w++) {
    for (let i = 0; i < tokens.length; i++) {
      if (componentMatchesToken(tokens[i], words[w])) hits.push({ pos: i, word: w });
    }
  }
  if (new Set(hits.map(h => h.word)).size < words.length) return false;
  hits.sort((a, b) => a.pos - b.pos);

  const counts = new Array(words.length).fill(0);
  let distinct = 0;
  for (let left = 0, right = 0; right < hits.length; right++) {
    if (counts[hits[right].word]++ === 0) distinct++;
    while (distinct === words.length) {
      if (hits[right].pos - hits[left].pos <= window) return true;
      if (--counts[hits[left].word] === 0) distinct--;
      left++;
    }
  }
  return false;
}

/** Core word-boundary match (no space normalization). */
function matchesKeywordExact(title: string, keyword: string): boolean {
  const titleLower = title.toLowerCase();
  const kw = keyword.toLowerCase();
  const idx = titleLower.indexOf(kw);
  if (idx === -1) return false;

  // Require word boundary on the left (no alphanumeric before).
  // Left boundary prevents mid-word matches like "DESKTOP" matching "skt".
  const charBefore = idx > 0 ? titleLower[idx - 1] : ' ';
  if (/[a-z0-9]/i.test(charBefore)) return false;

  // Right side is unrestricted for normal-length keywords so model variants
  // match naturally:
  //   "german" → "Germany"                     ✓
  //   "mauser" → "Mausers"                     ✓
  //   "glock"  → "Glock17"                      ✓
  // but SHORT, PURELY-ALPHABETIC aliases require a RIGHT boundary too, so a
  // bare "mag" does not prefix-match "Magnum"/"Magpul"/"MAG526". Short aliases
  // that contain a digit or symbol ("g19", "m&p", ".45") are model codes whose
  // prefix-into-variant IS desired, so they keep right-unbounded matching. (See
  // isShortAlphaAlias.)
  if (isShortAlphaAlias(kw)) {
    const charAfter = idx + kw.length < titleLower.length ? titleLower[idx + kw.length] : ' ';
    if (/[a-z0-9]/i.test(charAfter)) return false;
  }
  return true;
}

/**
 * Extended matching: check if a keyword appears in the combined text
 * of title + tags + URL slug (not just title alone).
 *
 * This extends matchesKeyword to also search tags and URL slugs,
 * so "ammo" matches a product tagged "ammunition" even if the title
 * doesn't contain "ammo".
 */
export function matchesWithExtras(
  title: string,
  keyword: string,
  extras?: { tags?: string | null; urlSlug?: string },
): boolean {
  const combined = [title, extras?.tags || '', extras?.urlSlug || ''].join(' ');
  return matchesKeyword(combined, keyword);
}

// ── Category Filter Words ────────────────────────────────────────────────────

/**
 * Words that indicate a category filter, not a search term.
 * When a keyword like "7.62x39 ammo" is parsed, "ammo" is a category hint —
 * the user wants products matching "7.62x39" that are in the ammunition category.
 *
 * Maps the filter word to the tags/productType values it should match.
 */
const CATEGORY_FILTERS: Record<string, { tags: string[]; productTypes: string[] }> = {
  ammo:        { tags: ['ammunition'], productTypes: ['ammunition'] },
  ammunition:  { tags: ['ammunition'], productTypes: ['ammunition'] },
  rifle:       { tags: ['firearms'], productTypes: ['firearm'] },
  rifles:      { tags: ['firearms'], productTypes: ['firearm'] },
  gun:         { tags: ['firearms'], productTypes: ['firearm'] },
  guns:        { tags: ['firearms'], productTypes: ['firearm'] },
  firearm:     { tags: ['firearms'], productTypes: ['firearm'] },
  firearms:    { tags: ['firearms'], productTypes: ['firearm'] },
  mag:         { tags: ['magazines'], productTypes: ['parts'] },
  mags:        { tags: ['magazines'], productTypes: ['parts'] },
  magazine:    { tags: ['magazines'], productTypes: ['parts'] },
  magazines:   { tags: ['magazines'], productTypes: ['parts'] },
  optic:       { tags: ['optics'], productTypes: ['optics'] },
  optics:      { tags: ['optics'], productTypes: ['optics'] },
  scope:       { tags: ['optics'], productTypes: ['optics'] },
  scopes:      { tags: ['optics'], productTypes: ['optics'] },
};

/**
 * Parse a keyword into a search term + optional category filter.
 *
 * "7.62x39 ammo"  → { searchTerm: "7.62x39", categoryFilter: ammunition }
 * "sks"           → { searchTerm: "sks", categoryFilter: null }
 * "rifle ammo"    → { searchTerm: "rifle", categoryFilter: ammunition }
 *                    (both are category words, last one = filter, first = sub-qualifier)
 * "shotgun ammo"  → { searchTerm: "shotgun", categoryFilter: ammunition }
 * "sks magazine"  → { searchTerm: "sks", categoryFilter: magazines }
 */
function parseKeywordWithCategory(keyword: string): {
  searchTerm: string;
  categoryFilter: { tags: string[]; productTypes: string[] } | null;
} {
  const words = keyword.toLowerCase().trim().split(/\s+/);
  if (words.length < 2) return { searchTerm: keyword, categoryFilter: null };

  // Check if the last word is a category filter
  const lastWord = words[words.length - 1];
  const filter = CATEGORY_FILTERS[lastWord];
  if (!filter) return { searchTerm: keyword, categoryFilter: null };

  // The remaining words form the actual search term
  const searchWords = words.slice(0, -1);
  const searchTerm = searchWords.join(' ');

  // Only split if the search term is meaningful
  if (searchTerm.length < 2) return { searchTerm: keyword, categoryFilter: null };

  return { searchTerm, categoryFilter: filter };
}

// ── Instant Search (for new Search creation) ────────────────────────────────

/**
 * Query ProductIndex for existing products matching a keyword.
 * Called when a user creates a new Search for instant results.
 *
 * Supports category-qualified keywords: "7.62x39 ammo" searches for "7.62x39"
 * but only returns products tagged as ammunition.
 */
export async function searchProductIndex(
  keyword: string,
  siteIds?: string[],
  options?: {
    inStockOnly?: boolean;
    maxPrice?: number;
    changedSince?: Date;
    minPrice?: number;
    stock?: 'all' | 'in' | 'out';
    ammo?: 'include' | 'exclude';
    sortBy?: 'newest' | 'updated' | 'price_asc' | 'price_desc';
  },
): Promise<Array<{ url: string; title: string; price: number | null; regularPrice: number | null; thumbnail: string | null; siteId: string; firstSeenAt: Date; contentChangedAt: Date; stockStatus: string | null; category: string | null; productType: string | null }>> {
  // Parse keyword for category filter: "7.62x39 ammo" → search "7.62x39", filter to ammunition
  const { searchTerm, categoryFilter } = parseKeywordWithCategory(keyword);
  const aliases = await expandKeyword(searchTerm);

  // Build OR conditions for all aliases — search title, tags, and URL
  // (word boundary matching in SQL is expensive, so we do a broad ILIKE filter then refine in JS)
  // Also include space/hyphen-stripped variants so "tm 22" matches "TM22", "ar-15" matches "AR15"
  const aliasVariants = [...new Set(aliases.flatMap(alias => {
    const stripped = alias.replace(/[\s\-]+/g, '');
    return stripped !== alias ? [alias, stripped] : [alias];
  }))];

  // For multi-word keywords like "mauser 308", split into individual words
  // and require ALL words match (AND logic) instead of exact phrase substring.
  // Each word must appear in title, tags, or URL independently.
  const buildWordFilter = (word: string) => ({
    OR: [
      { title: { contains: word, mode: 'insensitive' as const } },
      { tags: { contains: word, mode: 'insensitive' as const } },
      { url: { contains: word, mode: 'insensitive' as const } },
    ],
  });

  // Check if any alias has multiple words
  const hasMultiWord = aliasVariants.some(a => a.includes(' '));
  let searchFilter: any;

  if (hasMultiWord) {
    // Build OR across aliases; for multi-word aliases, AND each word
    searchFilter = {
      OR: aliasVariants.map(alias => {
        const words = alias.split(/\s+/).filter((w: string) => w.length >= 2);
        if (words.length >= 2) {
          // AND logic: each word must appear somewhere in title/tags/url
          return { AND: words.map(buildWordFilter) };
        }
        // Single word: normal contains
        return buildWordFilter(alias);
      }),
    };
  } else {
    // All single-word aliases: simple OR across all
    searchFilter = {
      OR: aliasVariants.flatMap(alias => [
        { title: { contains: alias, mode: 'insensitive' as const } },
        { tags: { contains: alias, mode: 'insensitive' as const } },
        { url: { contains: alias, mode: 'insensitive' as const } },
      ]),
    };
  }

  // Shared keyword/recency/stock predicates (everything EXCEPT site scoping +
  // the maintain-phase gate). Reused by both the site-scoped and all-sites paths
  // so the matching semantics are identical between them.
  const matchWhere = {
    isActive: true,
    ...(options?.inStockOnly ? { stockStatus: { not: 'out_of_stock' as const } } : {}),
    // Cursor filter: only products first-seen OR content-changed after the cursor.
    // Combined via AND so it doesn't clobber searchFilter's top-level `OR` key
    // (both keyword match AND cursor recency must hold). Uses
    // @@index([siteId, contentChangedAt]); ordered by contentChangedAt so
    // recently-changed (not just recently-first-seen) rows are within the take cap.
    ...(options?.changedSince
      ? { AND: [{ OR: [{ firstSeenAt: { gt: options.changedSince } }, { contentChangedAt: { gt: options.changedSince } }] }] }
      : {}),
    ...searchFilter,
  };
  const orderBy = options?.changedSince
    ? { contentChangedAt: 'desc' as const }
    : { firstSeenAt: 'desc' as const };

  // Only surface products from sites we're actively maintaining: enabled, not
  // paused, AND past bootstrap (crawlPhase='maintain'). A disabled or
  // still-bootstrapping site has stale/incomplete data (e.g. sold listings never
  // re-verified, partial catalog), so its indexed rows must not appear in search
  // or alerts even though they exist in the DB.
  const maintainSite = { isEnabled: true, isPaused: false, crawlPhase: 'maintain' };

  let products: Awaited<ReturnType<typeof prisma.productIndex.findMany>>;

  if (siteIds && siteIds.length > 0) {
    // ── SITE-SCOPED path (unchanged behavior) ─────────────────────────────────
    // Every production caller except the global /search route lands here with a
    // single siteId; this query, its orderBy, its SEARCH_INDEX_CAP, and the
    // cap-hit observability are byte-for-byte the original behavior. A single
    // site's matching set never approaches 1000 for a real keyword, so the cap
    // here is a safety ceiling, not the cross-site fairness problem.
    products = await prisma.productIndex.findMany({
      where: { site: maintainSite, siteId: { in: siteIds }, ...matchWhere },
      orderBy,
      take: SEARCH_INDEX_CAP,
    });
    if (products.length === SEARCH_INDEX_CAP) {
      console.warn(
        `[keyword-matcher] searchProductIndex hit SEARCH_INDEX_CAP=${SEARCH_INDEX_CAP} for keyword="${keyword}" siteIds=${siteIds.join(',')} — results may be truncated`,
      );
      pushEvent({
        type: 'info',
        keyword,
        message: `searchProductIndex hit SEARCH_INDEX_CAP=${SEARCH_INDEX_CAP} — results may be truncated`,
        data: { keyword, siteIds, cap: SEARCH_INDEX_CAP },
      });
    }
  } else {
    // ── ALL-SITES path (fair per-site sampling) ───────────────────────────────
    // The old single global `take: SEARCH_INDEX_CAP` ordered by firstSeenAt
    // starved low-volume sites (the newest 1000 matches clustered on a few
    // high-volume sites). Instead, fetch the newest PER_SITE_CAP matches PER
    // maintain-site so every site is represented, then merge + globally re-sort
    // by the same key the consumers expect. (No caller passes changedSince with
    // undefined siteIds, but the orderBy is honored either way.)
    const sites = await prisma.monitoredSite.findMany({
      where: maintainSite,
      select: { id: true },
    });
    const ids = sites.map(s => s.id);
    const perSite = await mapSettledWithConcurrency(ids, 8, siteId =>
      prisma.productIndex.findMany({
        where: { siteId, ...matchWhere },
        orderBy,
        take: PER_SITE_CAP,
      }),
    );
    // Keep only successful sites; drop (don't throw on) any site whose query
    // rejected, so one Neon hiccup can't 500 the whole 56-query search.
    products = perSite.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    const failedSites = ids.filter((_, i) => perSite[i].status === 'rejected');
    // Re-sort the merged set globally so the final ordering matches the
    // site-scoped path's "newest first" (or "most-recently-changed first") order.
    const orderKey: 'contentChangedAt' | 'firstSeenAt' = options?.changedSince ? 'contentChangedAt' : 'firstSeenAt';
    products.sort((a, b) => b[orderKey].getTime() - a[orderKey].getTime());

    // Observability: a site that returned exactly PER_SITE_CAP broad rows was
    // truncated before refinement for THIS keyword (expected only for bare
    // category words on the biggest sites — see PER_SITE_CAP note); and a failed
    // site was dropped entirely. Both degrade coverage, so surface both.
    const cappedSites = perSite.filter(r => r.status === 'fulfilled' && r.value.length === PER_SITE_CAP).length;
    if (cappedSites > 0 || failedSites.length > 0) {
      console.warn(
        `[keyword-matcher] searchProductIndex all-sites coverage degraded for keyword="${keyword}": ` +
        `${cappedSites} site(s) hit PER_SITE_CAP=${PER_SITE_CAP} (per-site truncated)` +
        (failedSites.length > 0 ? `, ${failedSites.length} site(s) query FAILED and were dropped (${failedSites.join(',')})` : ''),
      );
      pushEvent({
        type: 'info',
        keyword,
        message: `searchProductIndex all-sites coverage degraded: ${cappedSites} capped, ${failedSites.length} failed`,
        data: { keyword, siteIds: null, perSiteCap: PER_SITE_CAP, cappedSites, failedSites },
      });
    }
  }

  // Refine with word-boundary matching on title, tags, or URL slug
  // Use aliasVariants (includes space-stripped forms) for matching
  const refined = products
    .filter(p => {
      const urlSlug = p.url.split('/').pop()?.replace(/-/g, ' ') || '';
      if (!aliasVariants.some(alias => matchesWithExtras(p.title, alias, { tags: p.tags, urlSlug }))) {
        return false;
      }
      // Apply category filter if present
      if (categoryFilter) {
        const matchesTags = p.tags && categoryFilter.tags.some(t => p.tags!.toLowerCase().includes(t));
        const matchesType = p.productType && categoryFilter.productTypes.includes(p.productType);
        if (!matchesTags && !matchesType) return false;
      }
      // Apply price ceiling if present — a null-price product can't satisfy it
      if (options?.maxPrice != null && !(p.price != null && p.price <= options.maxPrice)) {
        return false;
      }
      // Apply price floor if present — a null-price product can't satisfy it
      if (options?.minPrice != null && !(p.price != null && p.price >= options.minPrice)) {
        return false;
      }
      // Stock filter (explicit). When set it overrides the legacy inStockOnly
      // (which still applies at the SQL `where` above for other callers).
      if (options?.stock === 'in' && p.stockStatus !== 'in_stock') return false;
      if (options?.stock === 'out' && p.stockStatus !== 'out_of_stock') return false;
      // Ammo filter — 'exclude' hides ammunition; 'include'/undefined keeps all.
      if (options?.ammo === 'exclude' && p.productType === 'ammunition') return false;
      return true;
    })
    .map(p => ({
      url: p.url,
      title: p.title,
      price: p.price,
      regularPrice: p.regularPrice ?? null,
      thumbnail: p.thumbnail,
      siteId: p.siteId,
      firstSeenAt: p.firstSeenAt,
      contentChangedAt: p.contentChangedAt,
      stockStatus: p.stockStatus,
      category: p.category,
      productType: p.productType,
    }));

  // Sort ONLY when sortBy is provided. When absent, leave the current ordering
  // exactly as-is (the dispatcher relies on the changedSince/contentChangedAt
  // SQL ordering, and other callers expect today's firstSeenAt-desc behavior).
  if (options?.sortBy) {
    // NULL prices sort last in both price directions.
    const byPriceAsc = (a: typeof refined[number], b: typeof refined[number]) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    };
    switch (options.sortBy) {
      case 'price_asc':
        refined.sort(byPriceAsc);
        break;
      case 'price_desc':
        refined.sort((a, b) => {
          if (a.price == null && b.price == null) return 0;
          if (a.price == null) return 1;
          if (b.price == null) return -1;
          return b.price - a.price;
        });
        break;
      case 'updated':
        refined.sort((a, b) => b.contentChangedAt.getTime() - a.contentChangedAt.getTime());
        break;
      case 'newest':
        refined.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
        break;
    }
  }

  return refined;
}
