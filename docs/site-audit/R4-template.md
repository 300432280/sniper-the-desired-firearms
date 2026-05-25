# R4 Synthesis Template

Single source of truth for the shape an R4 (orchestrator synthesis) artifact must follow.
Filename convention: `docs/site-audit/YYYY-MM-DD-B{N}R4-synthesis.md`.

WHY this template exists: batch-4 R4 synthesis (2026-05-19) caught two cases where R2's
number was right but the narrative was wrong (hical `?modified_after` on Store API;
canadafirstammo `perPage 20-vs-50 throttle`). Without an explicit split, the R4 author
risks lumping load-bearing corrections (change DB) with narrative corrections (change
docs only). Only the load-bearing ones change production behavior — and only the
load-bearing ones should pressure operator review time.

---

## Required sections

### A. Per-site final corrections (TABLE)
One row per site in the batch. Columns: `Site` | `Final correction set`.
The correction set MUST be plain prose listing only the fields/values that the
operator should change in the DB siteProfile, with one-line citations to evidence.

### B. Cross-cutting lessons by artifact
Three named sub-sections — even if any one is empty for this batch:

- **B1. SKILL.md gaps** — bullets numbered, biggest first. Items the harness skill
  must teach future R1/R2 agents to avoid repeating the failure. NUMBER each item.

- **B2. Runtime code bugs** — file:line citations only. These are NOT for this R4
  to fix — they belong on a separate `fix/...` branch. The R4 must SCOPE them
  (silent / dormant / active) and mark "Action: backfill DB" vs "Action: ship code
  fix" so the next sprint plan can sort.

- **B3. Harness/methodology gaps (R1→R2→R3 process)** — items the audit harness
  itself missed (sample too narrow, prompt too leading, persona missing a lesson).
  These changes land in persona files + CLAUDE.md, NOT siteProfile DB.

### C. Bottom-line
≤5 sentences. State the highest-impact correction in the batch and the operator
decisions still owed (verifyMethod policy, catalogUrls strategy, etc.).

---

## Mandatory R4 split: DB-changes vs documentation-only

Every correction surfaced by R3 must be labeled, EXPLICITLY, as one of:

1. **DB change** — operator must update `siteProfile` in production DB. Touches a
   number / shape / enum value the runtime reads. Example (batch-4):
   `canadafirstammo expectedProductCount: 962 → 132` (prevents
   bootstrap-stuck-forever via `verifyBootstrapCoverage` ratio gate).

2. **Documentation-only update** — narrative bug. The runtime already does the
   right thing or the wrong narrative will mislead the next auditor. Touches
   persona files, CLAUDE.md, SKILL.md, or audit notes. Example (batch-4):
   "Hical's `Store API ignores modified_after — needs after`" — runtime adapter at
   `woocommerce.ts:419` already uses the correct per-surface param; the narrative
   bug was in R2's mental model.

Layout the synthesis must use — either inline tags in the Section A table:

```
| Site | Final correction set |
|---|---|
| sitefoo.com | [DB] expectedProductCount=132. [DB] verifyMethod=detail-page. [DOC] R2 claimed the cause was X — actually Y; runtime is fine. |
```

…or a second pass at the end of Section A listing "DOC-ONLY narrative fixes"
that did NOT change any DB field.

WHY: when the operator's review eyes scan an R4, they should be able to identify
in one pass which corrections actually need a DB write. Mixing load-bearing
numeric corrections with "narrative was off" notes makes the load-bearing ones
easier to miss.

---

## Required harness-blocked classification

When R3 cites a probe it could not run (auth-attempt, path-traversal, large-body
POST, shellshock, etc.) because the subagent harness/GateGuard refused, the R4
synthesis must promote that to a visible bucket — NOT bury it as
"couldn't disprove." Suggested label: `untested-by-harness`. Counts must be
reported separately at the top of the R4 (the existing line
`"R3 tally: N substantive counters; M couldn't-disprove; K untested-low-risk"`
should add a fourth bucket: `; H untested-by-harness`).

WHY: batch-4 wolverine R3 substituted passive `__cf_bm` + `cf-cache-status:DYNAMIC`
fingerprint evidence for blocked attack probes. Without this bucket, the R4
implies "WAF behavior fully verified" when the attack surface was untested.

---

## Reference batches

- `docs/site-audit/2026-05-15-R4-synthesis.md` (batch 3, 10 sites)
- `docs/site-audit/2026-05-19-B4R4-synthesis.md` (batch 4, 10 sites — first
  synthesis that explicitly distinguished DB vs DOC; informed this template)
