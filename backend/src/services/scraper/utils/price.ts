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
  // Reject values that are likely calibers (e.g. 7.62, 5.56, 22, 308) rather than prices
  if (value < 10) return undefined;
  return value > 0 ? value : undefined;
}

/** Extract price from forum thread titles like "WTS Glock 19 - $800" or "$450 OBO" */
export function extractPriceFromTitle(title: string): number | undefined {
  const match = title.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return undefined;
  const value = parseFloat(match[1].replace(/,/g, ''));
  return value > 0 ? value : undefined;
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
