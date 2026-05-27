/** Extract price from text like "$1,299.99", "CAD $800", or "C$86.99" */
export function extractPrice(text: string): number | undefined {
  // Match C$, CAD $, or plain $ followed by a number
  const match = text.match(/(?:CAD\s*|C)?\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) {
    // Try plain number pattern "1299.99" but only if it looks like a price (2 decimal places)
    const numMatch = text.match(/([\d,]+\.\d{2})\b/);
    if (numMatch) {
      const value = parseFloat(numMatch[1].replace(/,/g, ''));
      return value > 0 ? value : undefined;
    }
    return undefined;
  }
  const value = parseFloat(match[1].replace(/,/g, ''));
  // The `$`-anchored branch above is unambiguous currency — accept any positive value.
  // (The bare-number fallback applies the caliber-confusion guard `< 10` because
  // values like `7.62` could be a caliber. A `$5.99` literal cannot. Without this
  // fix, sub-$10 catalog items — primers, cleaning patches, small accessories —
  // are silently dropped, producing null-price rows on activant-inet, etc.)
  return value > 0 ? value : undefined;
}

/** Extract price from forum thread titles like "WTS Glock 19 - $800" or "$450 OBO".
 *  Also handles suffix-$ (French-Canadian / Western-Canadian classifieds convention,
 *  e.g. "125$", "9,99$", "10$ each") when no prefix-$ price is present. */
export function extractPriceFromTitle(title: string): number | undefined {
  // Prefix: $123 / $1,234.56 (standard convention)
  const prefix = title.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (prefix) {
    const value = parseFloat(prefix[1].replace(/,/g, ''));
    if (value > 0) return value;
  }
  // Suffix: 125$ / 9,99$ / 10$ — French-Canadian + Western-Canadian classifieds.
  // Use comma OR dot for decimal separator. Require the $ to immediately follow
  // the digit (no whitespace) to avoid accidental matches in mixed text.
  // Pick the FIRST suffix-$ value (typically the asking price).
  const suffix = title.match(/(\d+(?:[.,]\d{1,2})?)\$/);
  if (suffix) {
    const value = parseFloat(suffix[1].replace(',', '.'));
    if (value > 0) return value;
  }
  return undefined;
}

/** Extract bid amount from auction text like "Current Bid: $1,200" */
export function extractBidPrice(text: string): number | undefined {
  const patterns = [
    /(?:Current Bid|Winning Bid|High Bid|Starting Bid|Estimate|Hammer)[:\s]*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (value > 0) return value;
    }
  }
  return undefined;
}
