import type * as cheerio from 'cheerio';

/** Determine whether a product element indicates the item is in stock */
export function isInStock(element: cheerio.Cheerio<any>): boolean {
  const text = element.text().toLowerCase();
  const outTerms = ['out of stock', 'sold out', 'unavailable', 'backordered', 'discontinued'];
  const inTerms = ['in stock', 'add to cart', 'buy now', 'available', 'order now'];

  if (outTerms.some((t) => text.includes(t))) return false;
  if (inTerms.some((t) => text.includes(t))) return true;

  const btn = element.find('button[class*="cart"], button[class*="buy"], [id*="add-to-cart"]').first();
  if (btn.length && (btn.attr('disabled') !== undefined || btn.hasClass('disabled'))) return false;

  return true;
}
