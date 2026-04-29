// backend/scripts/probe/room5-bootstrap/strategy-dispatch.ts
// Pure decision: picks indexing strategy from NavigationState.
// No I/O — just reads state fields and returns the dispatch result.

import type { NavigationState } from '../shared/types';

export type IndexingStrategy = 'api-walk' | 'html-walk' | 'hybrid';
export type AdapterEntry = 'shopify' | 'woocommerce' | 'generic-retail' | 'classifieds-gunpost';

export type StrategyDispatchResult = {
  strategy: IndexingStrategy;
  adapterEntry: AdapterEntry;
  reason: string;
};

/**
 * Picks api-walk | html-walk | hybrid based on platform + coverage signals.
 *
 * - api-walk: Shopify (published_at sort per Mistake 32), WooCommerce (WP REST accessible),
 *   Ecwid-on-WordPress (Ecwid storefront API POST per Mistake 31)
 * - hybrid: BigCommerce Stencil + Klevu-equipped (API for count/URLs, HTML walk for metadata)
 * - html-walk: everything else — walk catalogUrls via extractCatalogProducts
 */
export function strategyDispatch(state: NavigationState): StrategyDispatchResult {
  const platform = state.platform;

  // Shopify: /products.json API walk with published_at sort (Mistake 32)
  if (platform === 'shopify') {
    return {
      strategy: 'api-walk',
      adapterEntry: 'shopify',
      reason: 'Shopify /products.json API walk sorted by published_at (Mistake 32: NOT created_at)',
    };
  }

  // WooCommerce: WP REST API walk (only if API was accessible in prior rooms)
  if (platform === 'woocommerce' || platform === 'woocommerce-headless') {
    // coverageStrategy from Room 3 already validated API accessibility
    if (state.coverageStrategy === 'api-walk') {
      return {
        strategy: 'api-walk',
        adapterEntry: 'woocommerce',
        reason: 'WooCommerce WP REST API walk (accessible, per_page=100, orderby=date)',
      };
    }
    // Fallback to HTML if API not accessible (WAF-gated, 401, etc.)
    return {
      strategy: 'html-walk',
      adapterEntry: 'generic-retail',
      reason: 'WooCommerce with inaccessible API — falling back to HTML walk',
    };
  }

  // Ecwid-on-WordPress: Ecwid storefront API POST per Mistake 31
  if (platform === 'ecwid-on-wordpress') {
    return {
      strategy: 'api-walk',
      adapterEntry: 'generic-retail',
      reason: 'Ecwid storefront API POST /catalog/search with sortBy:addedTimeDesc (Mistake 31)',
    };
  }

  // Drupal classifieds (gunpost.ca pattern)
  if (platform === 'drupal-commerce' || platform === 'classifieds-drupal') {
    return {
      strategy: 'html-walk',
      adapterEntry: 'classifieds-gunpost',
      reason: 'Drupal classifieds — HTML walk with Gunpost adapter selectors',
    };
  }

  // BigCommerce Stencil: hybrid (API for count, HTML for product metadata)
  if (platform?.includes('bigcommerce')) {
    if (state.coverageStrategy === 'hybrid') {
      return {
        strategy: 'hybrid',
        adapterEntry: 'generic-retail',
        reason: 'BigCommerce Stencil hybrid — API count + HTML walk for metadata',
      };
    }
    // If Room 3 didn't pick hybrid, honor its decision
    return {
      strategy: 'html-walk',
      adapterEntry: 'generic-retail',
      reason: 'BigCommerce Stencil HTML walk (Room 3 did not select hybrid)',
    };
  }

  // Klevu-equipped sites: hybrid
  if (state.coverageStrategy === 'hybrid') {
    return {
      strategy: 'hybrid',
      adapterEntry: 'generic-retail',
      reason: 'Klevu/API-equipped site — hybrid strategy from Room 3',
    };
  }

  // Everything else: html-walk via generic-retail extractCatalogProducts
  return {
    strategy: 'html-walk',
    adapterEntry: 'generic-retail',
    reason: `HTML walk for platform=${platform ?? 'unknown'} — generic retail extraction`,
  };
}
