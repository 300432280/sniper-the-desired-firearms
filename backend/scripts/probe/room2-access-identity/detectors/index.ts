// backend/scripts/probe/room2-access-identity/detectors/index.ts
import type { PlatformDetector } from '../platform-detect';
import { woocommerceDetector } from './woocommerce';
import { shopifyDetector } from './shopify';
import { bigcommerceStencilDetector } from './bigcommerce-stencil';
import { bigcommerceBlueprintDetector } from './bigcommerce-blueprint';
import { magento2xDetector } from './magento-2x';
import { magento1xDetector } from './magento-1x';
import { lightspeedEcomDetector } from './lightspeed-ecom';
import { lightspeedClassicDetector } from './lightspeed-classic';
import { opencartDetector } from './opencart';
import { volusionDetector } from './volusion';
import { nopcommerceDetector } from './nopcommerce';
import { odooDetector } from './odoo';

// Append-only registry. Adding a platform = 1 new file + 1 entry here.
// Order: most-specific markers first; tied confidences resolve to first registered.
// The platform-detect dispatcher picks the highest-confidence match across all detectors,
// so registry order only matters as a tiebreaker.
export const detectors: PlatformDetector[] = [
  bigcommerceStencilDetector,    // BC Stencil — explicit `<meta platform="bigcommerce.stencil">`
  bigcommerceBlueprintDetector,  // BC Blueprint — BC markers WITHOUT Stencil signature
  magento2xDetector,             // M2 — modern static/version + requirejs + Magento_* modules
  magento1xDetector,             // M1 — /skin/frontend + /js/mage + /catalog/product/view/id/N
  lightspeedEcomDetector,        // hosted Shoplightspeed (modern eCom platform)
  lightspeedClassicDetector,     // legacy SEOshop / Lightspeed Retail (webshopapp themes)
  opencartDetector,              // OpenCart 2.x/3.x — catalog/view/theme + index.php?route=
  volusionDetector,              // Volusion — `x-powered-by: Volusion` + `/v/vspfiles/`
  nopcommerceDetector,           // nopCommerce — `<meta generator="nopCommerce">` + `Nop.customer` cookie
  odooDetector,                  // Odoo Website+eCommerce — `<meta generator="Odoo">` + `var odoo = {`
  shopifyDetector,
  woocommerceDetector,
];
