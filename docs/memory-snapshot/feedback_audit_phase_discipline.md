---
name: audit-phase-discipline
description: 34-site audit reporting + verification discipline — phases reported separately, sort/pagination/API watermark all live-verified per catalogUrl, heavy WAF re-probed per audit
type: feedback
---

## Rules (user-enforced 2026-04-09 during site 31 audit)

### 1. Report phases SEPARATELY, not bundled
**Why:** Site 29 (surplusherbys) and site 30 (theammosource) history entries report each Phase in its own section, one phase per turn. Bundling Phase 1+2+3+4+5 into one report hides gaps and prevents user pushback on intermediate findings.
**How to apply:** For every site audit, return one Phase at a time. Wait for user confirmation/pushback before advancing. Match the Site 29/30 section structure: `## Phase 1 — WAF`, `## Phase 2 — Platform + count`, `## Phase 3 — catalogUrls`, `## Phase 4 — Sort`, `## Phase 5 — Pagination`, `## Phase 6 — Final verification`, `## Profile diff`, `## Final state`, `## Lessons added`.

### 2. Sort must be verified PER catalogUrl, not just /shop default
**Why:** Site 30 theammosource re-audit caught that "newest == default" was a false negative on some categories and real honor on others. Testing sort on one category URL does not prove it works on all. T1 watermark uses sort on every catalogUrl.
**How to apply:** For every catalogUrl in the final profile, run the ID-jump test:
- Page 1 default first product ID
- Page 1 `?sort=newest` (or equivalent) first product ID — different?
- Page 1 counter-control (`?sort=alphaasc` / `?orderby=price`) — different from both?
- Page 2 with sort — first product IDs strictly lower than page 1 (proves sort survives pagination)
Record per-URL sort outcome (honored / honored-default-is-newest / noop-small) in profile `categoryStats`.

### 3. Pagination must be WALKED, not just detected
**Why:** "Max page = 297" from a pagination widget is a detection, not proof. LightSpeed (Mistake 26), Wix sub-cats (Mistake 27), and many sites silently serve page-1 content on page-2 URLs. Only walking page 2 and comparing products to page 1 proves pagination works.
**How to apply:** For every catalogUrl:
- Fetch page 1, capture first 3 product URLs
- Fetch page 2, capture first 3 product URLs
- Prove they are DIFFERENT (Set intersection = empty)
- Walk a few more pages if the site is small enough to finish in <60s
- Record zero-overlap proof in profile notes

### 4. API-based watermark methods require a live filter test
**Why:** Reading `x-wp-total: 11039` from `/wp-json/wc/store/v1/products?per_page=1` proves the endpoint exists and counts products — it does NOT prove that `?after=YYYY-MM-DD` filtering works. Many WP plugins override the Store API and ignore `after`/`before`/`orderby`. T1 `api-date-since-watermark` depends on the filter working.
**How to apply:** When proposing `crawlers.watermark.method: 'api-date-since-watermark'` (or equivalent API watermark):
- Live-call the API with `?orderby=date&order=desc&after=<a date 7 days ago>` and capture the response
- Verify the response contains ONLY products with `date_created >= after`
- Verify `?before=<date>` excludes newer products
- Count results vs a baseline call without `after` — must be strictly smaller
- Record the exact working query string in profile `productCountMethod.endpoint`

### 5. Heavy WAF probe must be re-run (or at minimum re-confirmed) per audit
**Why:** Playbook Mistake 23 mandates the heavy 8-batch probe. Accepting a prior probe's verdict without running it fresh this session is a shortcut that has burned us before (prior subagent accepted the first subagent's "SiteGround sgcaptcha" finding without independent verification). The 8-batch evidence must be in the profile `wafProbeEvidence` field at audit completion.
**How to apply:** Every audit runs `bash backend/scripts/heavy-waf-probe.sh <target>` fresh and records the full 8-batch result in profile `wafProbeEvidence`, even if a prior session already probed. Update `wafLastProbedAt` to the session's ISO timestamp. If the prior result is from the same session, cite it explicitly.

## Cross-references
- Playbook Mistake 23 (heavy WAF probe mandatory)
- Playbook Mistake 26 (silent pagination ignore — LightSpeed)
- Playbook Mistake 29 (BC Stencil 3-outcome sort verification)
- Site 29 surplusherbys + Site 30 theammosource history entries as the canonical report format
