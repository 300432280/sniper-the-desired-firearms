// backend/scripts/probe/access-identity/detectors/opencart.ts
// OpenCart (stock 2.x / 3.x). Identified by canonical asset paths and the
// `index.php?route=...` URL contract that the stock front controller emits on
// every page (homepage, category, product). The stock dark/default themes also
// surface a "Powered By OpenCart" footer link unless the merchant strips it.
//
// Reference markers verified live (2026-04-25):
// - northprosports.com (OpenCart stock 2.x/3.x, dark_velvet theme)
//   - `catalog/view/theme/dark_velvet/stylesheet/stylesheet.css`
//   - `index.php?route=product/category&path=...` nav links
//   - `index.php?route=product/product&product_id=...` product links
//   - `image/cache/catalog/...` image cache pattern
//   - `<a href="http://www.opencart.com">OpenCart</a>` powered-by link in footer
//
// NOTE: `<select id="input-sort">` is a category-page-only marker (not on the
// homepage), so this detector does NOT depend on it. The category-sort dropdown
// is consumed by the navigation stage (sort-param probe) — see Mistake 21 in the playbook for
// the OpenCart sort-param caveat (the dropdown is not exhaustive; the server
// also accepts `?sort=p.date_added&order=DESC`).
import type { PlatformDetector } from '../platform-detect';

export const opencartDetector: PlatformDetector = {
  id: 'opencart',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Highest-specificity marker: `catalog/view/theme/<theme>/` asset path.
    // Emitted by the stock front controller for every theme — merchant cannot
    // change this path without forking OpenCart's resource loader.
    if (/catalog\/view\/theme\/[A-Za-z0-9_-]+\//.test(html)) {
      signals.catalogViewThemePath = true;
      matched = true;
      confidence = 'high';
    }

    // Front controller URL contract — `index.php?route=product/category|product`.
    // Combined with the asset path this is canonical OpenCart.
    if (/index\.php\?route=product\/(category|product)/.test(html)) {
      signals.productRouteUrl = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
      else if (confidence === 'medium') confidence = 'high';
    }

    // Stock theme image cache directory.
    if (/\/image\/cache\/catalog\//.test(html)) {
      signals.imageCacheCatalog = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Powered-by link — strongest single marker when the merchant left it in
    // place (default behaviour). OpenCart's license encourages keeping it.
    if (/<a[^>]+href=["']https?:\/\/www\.opencart\.com["'][^>]*>OpenCart<\/a>/i.test(html)) {
      signals.poweredByOpencart = true;
      matched = true;
      confidence = 'high';
    }

    return { matched, confidence, signals };
  },
};
