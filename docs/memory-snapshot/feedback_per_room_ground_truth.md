---
name: per-room-ground-truth-validation
description: Each Room's output MUST be tested against the validated MonitoredSite.siteProfile DB column WHEN the Room is completed, not delayed. tsc-clean + per-module smoke tests are NOT enough. Bugs accumulate across rooms when validation is deferred.
type: feedback
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
# Per-room ground-truth validation is mandatory

**Rule:** When a Room (or any pipeline stage) is marked "complete," its output MUST be compared against the validated `MonitoredSite.siteProfile` JSON column for at least one Tier-1 ground-truth site BEFORE moving to the next phase. `tsc --noEmit` clean and module-level smoke tests are necessary but NOT sufficient.

**Why:** On 2026-04-26 I marked Phases 4 (Room 3), 5 (Room 4), and 6 (orchestrator) "complete" based only on per-module smoke tests + tsc clean. When I finally compared the orchestrator output (`docs/pre-bootstrap-output/canadafirstammo.ca-profile.json`) to the validated DB siteProfile during Phase 7 setup, multiple bugs surfaced simultaneously:

- Room 3 `walk-verify` under-counted by 16× on canadafirstammo (walked 58 vs validated 962) and gunpost (walked 15,969 vs validated ~36K active)
- Room 3 `catalog-urls` discovery missed `/training/` (DB has 10 catalog URLs, Room 3 found 9)
- Room 4 `watermark-method` picked Method B (`navigate-from-watermark`) for canadafirstammo when the validated answer is Method A (`api-date-since-watermark`)

These bugs would have been caught one at a time if each Room had been validated against ground truth at completion. Instead they accumulated across Phases 4 and 5 and blocked Phase 7 work entirely (Room 5 was being built on top of garbage inputs). User correctly called this out: *"you should have done the test for each room when they were completed, not delayed until now."*

**How to apply:**

1. **Definition of "Room complete" (raise the bar):**
   - tsc clean ✓
   - Module-level smoke ✓
   - **Output compared to ≥1 validated DB `siteProfile`, every overlapping field diffed, discrepancies investigated and either explained or fixed BEFORE the Room is committed**
2. **Comparison protocol:** Run the Room (or full pipeline up to that Room) on a Tier-1 site whose `siteProfile` is hand-curated and known good. Diff EVERY overlapping field. Any disagreement is treated as "MY code is wrong, validated profile is right" — never propose changing the validated profile to match my buggy output.
3. **`siteProfile` is the answer key.** Never modify it without explicit per-edit user permission. Never propose changes to it based on test results.
4. **Apply RETROACTIVELY when bugs are discovered:** if a Phase is marked complete but the validation step was skipped, that Phase is NOT complete — flip the todo back to in-progress and run the validation now.
5. **Phase 7+ exception (per spec):** Room 5 writes to DB, so live-against-DB testing is gated to Tasks 7.3-7.7. For Room 5, the validation step is dry-run mode comparing PLANNED writes to existing `siteProfile`.

**Tier-1 ground-truth sites (canonical comparison targets):**
- canadafirstammo.ca — WooCommerce + Cloudflare passive
- aagcanada.ca — Shopify + Cloudflare passive
- theammosource.com — BC Stencil + Cloudflare passive
- bullseyenorth.com — Celerant ColdFusion + no WAF
- gunpost.ca — Drupal classifieds + Cloudflare active

**Affected files / canonical evidence:**
- `docs/pre-bootstrap-output/<domain>-profile.json` — Room output to compare against
- `MonitoredSite.siteProfile` (DB JSONB column) — ground truth, hand-curated
- `34-site-audit-history.md` — per-site audit notes that match the validated siteProfile values

**Anti-pattern:** Marking Phases complete based on tsc + per-module smoke tests, deferring full-pipeline-vs-DB comparison to a later phase. Bugs always exist; deferred validation just means they're discovered later, when fixes are more expensive AND when downstream phases (built on top of broken outputs) become invalidated too.

**Cost example from this session:** Phase 7 Task 7.1 (Room 5 modules, ~1055 lines + 2 reviews + 16-fix iteration + ~hour of dispatch overhead) was wasted work because Rooms 3-4 were producing wrong inputs. Had each Room been validated at completion, Rooms 3-4 bugs would have been fixed in Phases 4-5 before Room 5 work began.
