---
name: full-product-coverage
description: catalogUrls must cover 100% of products, never drop categories for being "too small" — the user's design principle is ALL products with minimum overlap
type: feedback
---

## Rule
**catalogUrls must cover EVERY product on the site.** The playbook Phase 3 says "the smallest set of URLs that together cover EVERY firearm-relevant product with minimum overlap." EVERY means 100%. Not 92%. Not "close enough."

## Why
User pushback on Site 33 (truenortharms.com, 2026-04-10). The audit found 149 categories with products but only selected 66 categories with ≥5 unique products each, covering 1,162/1,264 = 92%. The remaining 84 categories with 1-4 products each (102 products total) were DROPPED with the rationale "not worth the crawl overhead."

User rejected this: "who told you you can leave a site with some item not been crawled? I need all product coverage with minimum overlap!"

## How to apply
1. If a platform's parent categories include children automatically (e.g. WooCommerce), use parent URLs — the children are already covered.
2. If a platform's parent categories do NOT include children (e.g. this BC Stencil theme), you MUST include ALL leaf categories in catalogUrls — even categories with 1 product.
3. **NEVER drop a category** because "it only has N products" or "it's not worth the overhead." Every product must be reachable via at least one catalogUrl.
4. The union of all walked catalogUrls must equal `expectedProductCount` within ~0.5% (for natural multi-cat overlap only, not missing coverage).
5. If including all leaves produces heavy overlap with parents, consider ONLY leaves. If leaves + parents are needed for full coverage, include both.

## Cross-references
- Playbook Phase 3 ("EVERY firearm-relevant product")
- Playbook Phase 3e ("minimum overlap check" — unique total ≈ API count from Phase 2)
- Site 33 truenortharms re-audit (2026-04-10)
