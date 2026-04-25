// backend/scripts/probe/room2-access-identity/detectors/index.ts
import type { PlatformDetector } from '../platform-detect';
import { woocommerceDetector } from './woocommerce';
import { shopifyDetector } from './shopify';
import { bigcommerceStencilDetector } from './bigcommerce-stencil';

// Append-only registry. Adding a platform = 1 new file + 1 entry here.
export const detectors: PlatformDetector[] = [
  bigcommerceStencilDetector,  // most specific first
  shopifyDetector,
  woocommerceDetector,
];
