---
name: feedback-stale-cleanup
description: Never deactivate products based on lastSeenAt alone — crawlers may not have reached the page yet
type: feedback
---

Do NOT deactivate products just because lastSeenAt is old. On large sites (gunpost: 16,000+ listings, 1,673 pages), the crawler can only visit ~50 pages/hour per tier. It takes weeks to cover the full catalog. A product with lastSeenAt > 14 days just means the crawler hasn't reached that page yet — NOT that the product was removed.

**Why:** I deactivated 4,273 gunpost products that were still live on the site. Users searching for those products got 0 results. The damage was reversible but should never have happened.

**How to apply:** A product should only be marked inactive if the crawler visited its page AND the product wasn't found. Never use a time-based threshold alone to deactivate products.
