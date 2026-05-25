# B5R3 Counter - durhamoutdoors.ca (2026-05-22T23:00:00Z)

Round 3 of 4. Adversarially disprove R2 corrections on the 3 priority surfaces.

## 1. searchUrl OMIT - ATTEMPTED DISPROOF, R2 HOLDS

Probed 9 alternative URL patterns (different from R1's `/search.asp?keyword=` and DB's `/search?q=`) live with 800ms delay, plus a full browser-header stack on `/search.asp`:

| URL | Status | Body | Verdict |
|---|---|---|---|
| `/search/?q=glock` | 404 | 1201B | dead |
| `/search/?keyword=glock` | 404 | 1201B | dead |
| `/?s=glock` | 200 | 68366B | **homepage echo (see below)** |
| `/?search=glock` | 200 | 68366B | **homepage echo** |
| `/search.html?keyword=glock` | 404 | 1201B | dead |
| `/store/search.asp?keyword=glock` | 403 | 4550B (CF) | WAF |
| `/search.asp?keyword=glock&searchtype=` | 403 | 4550B (CF) | WAF |
| `/products/search?q=glock` | 404 | 1201B | dead |
| `/catalogsearch/result/?q=glock` | 404 | 1201B | dead |
| `/search.asp?keyword=glock` w/ full Sec-Fetch + sec-ch-ua + Accept-Lang + Referer | 403 | 4550B (CF) | WAF |

The `?s=` 200 looked promising but is a homepage echo: byte-identical 68366B body for `?s=glock` vs `?s=xyz789nonsense` (junk keyword). Product-link count and "glock" substring count are identical in both bodies (63 product links, 6 "glock" hits) - proving the query is ignored and the server returns the homepage regardless of keyword.

**R2's "OMIT searchUrl" stands.**

## 2. wafType cloudflare-passive - ATTEMPTED DISPROOF, R2 HOLDS

Ran the demanded sustained 50-page walk across 4 categories (Rifles / NON-RESTRICTED / Shotgun / Accessories) with 4 rotating UAs (Chrome120 / Safari17 / Firefox121 / Edge120), 800ms delay, 54s wall.

```
Status dist: {"200":50}
```

All 50 returned full ~60KB catalog HTML. No challenge, no 403 escalation, no `cf-mitigated` header. **R2 cloudflare-passive verdict holds.**

## 3. paginationPattern.template '-{N}.html' - R2 CITED WRONG FILE, BUT VERDICT STANDS

R2 cited `generic-retail.ts:97/127-129`. That file at those lines is keyword-match logic, NOT pagination. Correct location: **`catalog-crawler.ts:127-135`**:

```ts
if (pattern?.type === 'suffix-replace') {
  const match = pattern.match || '.html';
  const template = pattern.template || '-{N}.html';
  ...
  const withoutSuffix = baseUrl.slice(0, baseUrl.length - match.length);
  return withoutSuffix + template.replace('{N}', String(pageNum));
}
```

Example: input `/Rifles_c_17.html` page=2 -> strip `.html` -> append `-2.html` -> `/Rifles_c_17-2.html`. Walk confirms: `/Rifles_c_17-2.html` returned 200/59813B in the sustained walk above. **R2 template form `-{N}.html` is correct.** Citation error only; not a verdict error.

## R3 verdict

All 3 priority R2 corrections withstand R3 attack. ZERO flips.

## Notes for R4

- R2's file citation for suffix-replace was wrong (`generic-retail.ts:97/127-129` is keyword-match code; actual logic is `catalog-crawler.ts:127-135`). Fix citation in next siteProfile audit-trail; verdict unaffected.
- New positive evidence for cloudflare-passive: 50-page sustained walk, 4 UAs, 0 challenges (R2 had 30; R3 confirms at 50).
- Homepage-echo trap: `?s=` and `?search=` return 200 but ignore the query. A naive "200 = valid searchUrl" heuristic would have been fooled here. Skill rule reminder: ANY candidate searchUrl must be diffed against a junk-keyword control to prove the query is honored.
