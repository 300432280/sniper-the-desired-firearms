/**
 * Backfill Match.productIndexId FK for existing matches.
 *
 * Strategy:
 *   1. Find all Match records where productIndexId IS NULL
 *   2. For each, look up ProductIndex by exact URL match
 *   3. If no URL match, try title similarity on the same site (strict)
 *   4. Log stale data (title/price drift) for linked matches
 *   5. Report: linked, unlinked, stale data, per-site breakdown
 *
 * Usage: cd backend && node scripts/backfill-match-fk.js [--dry-run]
 */
require('dotenv').config();
var PrismaClient = require('@prisma/client').PrismaClient;

var prisma = new PrismaClient();
var BATCH_SIZE = 500;
var DRY_RUN = process.argv.indexOf('--dry-run') >= 0;

// ── Title similarity ─────────────────────────────────────────────────────────

/**
 * Normalise a title for comparison: lowercase, strip non-alphanumeric,
 * collapse whitespace.
 */
function normaliseTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance (simple DP, fine for short strings).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  var matrix = [];
  for (var i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (var j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      var cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Title similarity ratio (0-1). Only consider a match if >= 0.90.
 */
function titleSimilarity(a, b) {
  var na = normaliseTitle(a);
  var nb = normaliseTitle(b);
  if (na === nb) return 1.0;
  var maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  var dist = levenshtein(na, nb);
  return 1 - dist / maxLen;
}

var TITLE_SIMILARITY_THRESHOLD = 0.90;

// ── Extract domain from URL ──────────────────────────────────────────────────

function extractDomain(url) {
  try {
    var u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Match FK Backfill ===');
  if (DRY_RUN) console.log('*** DRY RUN — no database writes ***');
  console.log('');

  // Pre-load all monitored sites for domain->siteId lookup
  var sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, name: true },
  });
  var siteByDomain = new Map();
  for (var s = 0; s < sites.length; s++) {
    siteByDomain.set(sites[s].domain, sites[s]);
  }

  // Stats
  var stats = {
    total: 0,
    linkedByUrl: 0,
    linkedByTitle: 0,
    unlinked: 0,
    staleTitle: 0,
    stalePrice: 0,
    staleBoth: 0,
    bySite: {},       // domain -> { linked, unlinked, stale }
    unlinkDetails: [], // for final report
  };

  function getSiteStat(domain) {
    if (!stats.bySite[domain]) {
      stats.bySite[domain] = { linked: 0, unlinked: 0, staleTitle: 0, stalePrice: 0 };
    }
    return stats.bySite[domain];
  }

  // Count total matches to backfill
  var totalNull = await prisma.match.count({
    where: { productIndexId: null },
  });
  console.log('Matches with productIndexId=NULL: ' + totalNull);
  if (totalNull === 0) {
    console.log('Nothing to backfill!');
    await prisma.$disconnect();
    return;
  }

  // Process in batches using cursor-based pagination
  var cursor = undefined;
  var processed = 0;

  while (true) {
    var findArgs = {
      where: { productIndexId: null },
      select: {
        id: true,
        title: true,
        price: true,
        url: true,
        searchId: true,
      },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    };
    if (cursor) {
      findArgs.skip = 1;
      findArgs.cursor = { id: cursor };
    }

    var batch = await prisma.match.findMany(findArgs);
    if (batch.length === 0) break;

    stats.total += batch.length;
    cursor = batch[batch.length - 1].id;

    // Collect all URLs from this batch for a bulk ProductIndex lookup
    var batchUrls = batch.map(function (m) { return m.url; });
    var piByUrl = await prisma.productIndex.findMany({
      where: { url: { in: batchUrls } },
      select: { id: true, url: true, title: true, price: true, siteId: true },
    });

    // Index by URL (could have dupes across sites, but match URL should be unique per site)
    var piUrlMap = new Map();
    for (var p = 0; p < piByUrl.length; p++) {
      var existing = piUrlMap.get(piByUrl[p].url);
      // If multiple PI rows have same URL, prefer the one that's active (we selected all)
      // Just store last one; exact URL match is already strong
      piUrlMap.set(piByUrl[p].url, piByUrl[p]);
    }

    // Process each match in the batch
    for (var i = 0; i < batch.length; i++) {
      var match = batch[i];
      var domain = extractDomain(match.url) || 'unknown';
      var siteStat = getSiteStat(domain);
      var pi = piUrlMap.get(match.url);

      if (!pi) {
        // Try normalised URL match (trailing slash difference)
        var normUrl = match.url.replace(/\/$/, '');
        for (var [piUrl, piRow] of piUrlMap) {
          if (piUrl.replace(/\/$/, '') === normUrl) {
            pi = piRow;
            break;
          }
        }
      }

      if (pi) {
        // URL match found
        if (!DRY_RUN) {
          await prisma.match.update({
            where: { id: match.id },
            data: { productIndexId: pi.id },
          });
        }
        stats.linkedByUrl++;
        siteStat.linked++;

        // Check for stale data
        checkStale(match, pi, domain, siteStat, stats);
        continue;
      }

      // No URL match — try title similarity on same site
      var site = siteByDomain.get(domain);
      if (site) {
        var titleMatch = await findByTitleOnSite(match, site.id);
        if (titleMatch) {
          if (!DRY_RUN) {
            await prisma.match.update({
              where: { id: match.id },
              data: { productIndexId: titleMatch.id },
            });
          }
          stats.linkedByTitle++;
          siteStat.linked++;
          checkStale(match, titleMatch, domain, siteStat, stats);
          continue;
        }
      }

      // Could not link
      stats.unlinked++;
      siteStat.unlinked++;
      if (stats.unlinkDetails.length < 50) {
        stats.unlinkDetails.push({
          matchId: match.id,
          domain: domain,
          url: match.url.substring(0, 100),
          title: (match.title || '').substring(0, 60),
        });
      }
    }

    processed += batch.length;
    if (processed % 1000 === 0 || processed === totalNull) {
      console.log('  Processed ' + processed + '/' + totalNull + ' matches (' +
        stats.linkedByUrl + ' URL, ' + stats.linkedByTitle + ' title, ' +
        stats.unlinked + ' unlinked)');
    }
  }

  // Final report
  console.log('\n=== Backfill Results ===');
  console.log('Total matches processed:  ' + stats.total);
  console.log('Linked by URL:            ' + stats.linkedByUrl);
  console.log('Linked by title:          ' + stats.linkedByTitle);
  console.log('Total linked:             ' + (stats.linkedByUrl + stats.linkedByTitle));
  console.log('Unlinked:                 ' + stats.unlinked);
  console.log('');
  console.log('Stale data detected:');
  console.log('  Title differs:          ' + stats.staleTitle);
  console.log('  Price differs:          ' + stats.stalePrice);
  console.log('  Both differ:            ' + stats.staleBoth);
  console.log('');

  // Per-site breakdown
  console.log('=== Per-Site Breakdown ===');
  var domains = Object.keys(stats.bySite).sort();
  for (var d = 0; d < domains.length; d++) {
    var ds = stats.bySite[domains[d]];
    var total = ds.linked + ds.unlinked;
    var pct = total > 0 ? Math.round((ds.linked / total) * 100) : 0;
    console.log('  ' + domains[d].padEnd(35) +
      ' linked=' + String(ds.linked).padStart(5) +
      ' unlinked=' + String(ds.unlinked).padStart(5) +
      ' (' + pct + '%)' +
      (ds.staleTitle > 0 ? ' staleTitle=' + ds.staleTitle : '') +
      (ds.stalePrice > 0 ? ' stalePrice=' + ds.stalePrice : ''));
  }

  if (stats.unlinkDetails.length > 0) {
    console.log('\n=== Sample Unlinked Matches (up to 50) ===');
    for (var u = 0; u < stats.unlinkDetails.length; u++) {
      var ud = stats.unlinkDetails[u];
      console.log('  [' + ud.domain + '] ' + ud.title + ' | ' + ud.url);
    }
  }

  await prisma.$disconnect();
}

function checkStale(match, pi, domain, siteStat, stats) {
  var titleStale = normaliseTitle(match.title) !== normaliseTitle(pi.title);
  var priceStale = false;
  if (match.price != null && pi.price != null) {
    priceStale = Math.abs(match.price - pi.price) > 0.01;
  }

  if (titleStale && priceStale) {
    stats.staleBoth++;
    stats.staleTitle++;
    stats.stalePrice++;
    siteStat.staleTitle++;
    siteStat.stalePrice++;
  } else if (titleStale) {
    stats.staleTitle++;
    siteStat.staleTitle++;
  } else if (priceStale) {
    stats.stalePrice++;
    siteStat.stalePrice++;
  }
}

/**
 * Try to find a ProductIndex row on the same site with a very similar title.
 * Only returns a result if similarity >= 0.90 AND it's the only strong match
 * (to avoid ambiguous linking).
 */
async function findByTitleOnSite(match, siteId) {
  var normTitle = normaliseTitle(match.title);
  if (!normTitle || normTitle.length < 5) return null;

  // Extract key words for a DB-level filter to avoid scanning the entire site
  var words = normTitle.split(' ').filter(function (w) { return w.length >= 4; });
  if (words.length === 0) return null;

  // Use the first 3 significant words for a LIKE-based pre-filter
  var filterWords = words.slice(0, 3);

  // Build a raw query with ILIKE filters to narrow candidates
  var candidates = await prisma.productIndex.findMany({
    where: {
      siteId: siteId,
      isActive: true,
      AND: filterWords.map(function (w) {
        return { title: { contains: w, mode: 'insensitive' } };
      }),
    },
    select: { id: true, title: true, price: true, url: true },
    take: 20, // reasonable limit
  });

  if (candidates.length === 0) return null;

  // Score each candidate
  var bestScore = 0;
  var bestCandidate = null;
  var secondBestScore = 0;

  for (var c = 0; c < candidates.length; c++) {
    var score = titleSimilarity(match.title, candidates[c].title);
    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestCandidate = candidates[c];
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  // Only accept if:
  // 1. Best score meets threshold
  // 2. There's clear separation from second-best (avoid ambiguity)
  if (bestScore >= TITLE_SIMILARITY_THRESHOLD &&
      (secondBestScore < TITLE_SIMILARITY_THRESHOLD - 0.05 || candidates.length === 1)) {
    return bestCandidate;
  }

  return null;
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
