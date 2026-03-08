import type * as cheerio from 'cheerio';

/** Determine whether a product element indicates the item is in stock */
export function isInStock(element: cheerio.Cheerio<any>): boolean {
  const text = element.text().toLowerCase();

  // Out-of-stock signals (check first — takes priority)
  const outTerms = [
    'out of stock', 'out-of-stock', 'temporarily out', 'sold out',
    'unavailable', 'backordered', 'discontinued', 'coming soon',
    'notify me when', 'notify when', 'back in stock', 'email me when',
    'email when available', 'waitlist', 'wait list', 'pre-order',
    'not available', 'currently unavailable',
  ];
  if (outTerms.some((t) => text.includes(t))) return false;

  // In-stock signals
  const inTerms = ['in stock', 'add to cart', 'buy now', 'available', 'order now'];
  if (inTerms.some((t) => text.includes(t))) return true;

  // Disabled cart/buy buttons → out of stock
  const btn = element.find(
    'button[class*="cart"], button[class*="buy"], [id*="add-to-cart"], ' +
    'input[type="submit"][value*="cart" i], input[type="submit"][value*="buy" i]'
  ).first();
  if (btn.length && (btn.attr('disabled') !== undefined || btn.hasClass('disabled'))) return false;

  // Default: unknown (callers should treat as 'unknown' rather than assuming in-stock)
  return true;
}
