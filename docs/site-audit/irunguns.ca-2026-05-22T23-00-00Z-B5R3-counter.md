# B5R3 Adversarial Counter — irunguns.ca

**Round:** R3 (re-walk to disprove R2; runtime trace)
**Date:** 2026-05-22T23:00:00Z
**Inputs:** R2 investigation + corrected JSON; live site; product-count-probe.ts L110-122, L222-229, L533-550.

## Re-walk evidence (fresh, 800ms-spaced unless noted)

```
BARE /product.php           status=200 showing="Showing 104 result" slugs=104
Σ 11 per-dept URLs          slugs=99
ORPHANS (bare − union)      5  (identical set to R2)
  nextlevel-training-sirt-training-magazine-weighted-plastic-black-finish
  atf-permit-application-pre-filing-fee
  colt-9mm-bcg-new-3738
  colt-hydr-buffer-w-buffer-spring
  xpedition-crossbow-kit-viking-x-380-rt-edge-380fps
```

**catalogUrls:** R2 holds. 11-dept misses same 5 orphans on independent walk.

```
SEARCH product_name=glock       status=200 anchors=208 showing="Showing 104 result"
SEARCH product_name=henry       status=200 anchors=208 showing="Showing 104 result"
SEARCH product_name=xyznomatch  status=200 anchors=208 showing="Showing 104 result"
SEARCH product_name=remington   status=200 anchors=208 showing="Showing 104 result"
SEARCH product_name=sirt        status=200 anchors=208 showing="Showing 104 result"
homepage FORM[1] action=""  inputs=product_name   (no endpoint declared)
```

**searchUrl:** R2 holds. 5 distinct keywords + nomatch all return identical 104-row set; homepage form has empty `action`. No working search endpoint exists. `null` is correct.

```
BURST_12_PARALLEL  200×12   (no delay, concurrent)
```

**hasWaf:** R2 holds. 12 concurrent zero-delay GETs all 200.

## productCountMethod runtime trace (L222-229, L533-550)

L227-229: `$('.showing_result').last().text().trim()` → live text `"Showing 104 result"` (count=1).
L540: `new RegExp('(\d+)')` (default) → `/(\d+)/`.
L545-548: match → `['104',...]` → `n=104` → `104 * perPage(1) = 104`.

Verified via `node --eval` with `String.raw`(\d+)``. Earlier `node -e` shell runs returned null only because Windows bash collapses `\\\\d+` → `\d+` → regex `/(d+)/`; that is a shell-quoting artifact, NOT a runtime defect.

## Verdict

R2 SURVIVES on all four targeted fields: catalogUrls, searchUrl, productCountMethod shape, hasWaf. No corrections required for R4.
