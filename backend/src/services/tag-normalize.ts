// backend/src/services/tag-normalize.ts
//
// Pure helper for cleaning the category tag that the catalog crawler stamps
// onto products. A catalogUrl whose last path segment is a file (e.g.
// `firearms.html`, `categories.php`, `ammo.aspx`) produces a stream.category
// like `ammunition.html`. When that string is written into ProductIndex.tags,
// a keyword search for "ammunition" tag-matches mis-categorized rows (e.g.
// fishing tackle stamped `fishing.html`), causing false positives.
//
// This strips a trailing file extension (.html/.htm/.php/.aspx/.asp) so the
// stored tag is the clean category slug. It does NOT touch stream.id — the
// stream id is derived separately in stream-detector.ts (deriveCategoryFromUrl)
// and changing it would orphan streamState for .html/.htm sites and reset their
// bootstrap. This is tag-only.

const TRAILING_EXT = /\.(html?|php|aspx?)$/i;

/**
 * Normalize a category string for use as a ProductIndex tag.
 * Strips a single trailing file extension and trims whitespace.
 * Returns null when the result is empty (so callers can skip tagging).
 */
export function normalizeTag(s: string): string | null {
  if (s == null) return null;
  const cleaned = s.trim().replace(TRAILING_EXT, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}
