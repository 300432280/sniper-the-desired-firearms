---
name: feedback-verify-before-propose
description: Never propose solutions before verifying actual behavior with real data — investigate first, suggest second
type: feedback
---

Do NOT propose solutions based on assumptions. Every time I assumed how something worked and proposed a fix, the assumption was wrong:
- Assumed old URLs break → they don't (Drupal keeps redirects)
- Assumed "not seen in 14 days" = removed → it doesn't (crawler hasn't visited yet)
- Assumed title matching could deduplicate → it can't (different listings can have similar titles)

**Why:** Three wrong solutions proposed in one session, each based on an unchecked assumption. The user had to discover the correct behavior themselves because I didn't test.

**How to apply:** When the user reports a problem or asks "is X true?":
1. Investigate — fetch the URL, query the DB, read the code
2. Understand — confirm the actual behavior with evidence
3. Then propose — only after step 1 and 2 are done

Never say "the fix would be..." before saying "let me check..."
