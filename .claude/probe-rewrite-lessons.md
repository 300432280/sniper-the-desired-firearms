# Probe Rewrite Lessons — Phase 1 (probe-access)

Reference for Phase 2+ probe development. Synthesized from the 2026-04-21 through 2026-04-23 session that fixed 4 probe bugs across 65 sites.

---

## 1. Methodology

### Follow the playbook, not your instincts
The catalog-url-discovery-playbook (`.claude/catalog-url-discovery-playbook.md`) and crawler-specialist persona (`.claude/agents/crawler-specialist.md`) contain 38 accumulated mistake patterns. Every probe design decision should cite the playbook section it implements.
- **Anti-pattern:** Designing detection logic from first principles without checking if a Mistake already covers it.

### Evidence-based decisions, not keyword heuristics
The orchestrator's `pickTestUrl` used `PRODUCT_LISTING_SIGNAL = /\b(firearm|rifle|shotgun|...)\b/i` to choose which URL to test. This is domain-specific guessing. The playbook Step 3d says: fetch top candidates, run production `extractCatalogProducts`, pick the one with the highest product count.
- **Example:** Gap C in `pre-bootstrap.ts:143-146` — keyword regex on URL path instead of empirical extraction.
- **Anti-pattern:** Using keyword regex when empirical extraction is available.

### Live site behavior is ground truth
When probe output disagrees with DB, verify live with `curl -sI` + body inspection. Three "operator exception" sites (ellwoodepps, fulcrum-outdoors, solelyoutdoors) were initially hand-waved as "fleet drift." After fresh curl probes, the real breakdown was: 4 probe bugs, 5 stale DB entries, 3 deliberate operator conventions, 0 actual fleet drift.
- **Anti-pattern:** Labeling probe-vs-DB disagreements as "drift" or "operator exceptions" without fresh live verification.

### Run skeptical review between plan and implementation
The first architecture plan (`_phase1-architecture.md`) proposed a new `vendor-signals.ts` module, `VendorSignals` interface with 7 sub-objects, `extractVendorSignals()` pure function, `synthesizeWafVerdict()`, and a full Node rewrite of `heavy-waf-probe.sh`. The code-reviewer agent (`_phase1-plan-review.md`) rejected it: Action 8 was a no-op, Action 7 was untestable against the dataset, and the "transient" diagnosis was unproven. The correct-scope plan (`_phase1-minimal-plan.md`) shipped 4 fixes in ~100 net insertions.
- **Anti-pattern:** Implementing the first plan without independent review.

---

## 2. Signal Detection

### A real challenge requires tiny body + vendor header + non-200 status, not just URL references
`cdn-cgi/challenge-platform` appearing in real page content (e.g., a Cloudflare-proxied site's JS bundle) is NOT a challenge. A real CF challenge has: status 403/503 + `cf-mitigated: challenge` header + body < 50KB with `Just a moment...` / `_cf_chl_opt`.
- **Example:** The original `WAF_BODY_CHALLENGE_RE` at `probe-access.ts:106` matched `cdn-cgi/challenge-platform` in normal page content, producing false positives.
- **Code ref:** `probe-access.ts:106` (`WAF_BODY_CHALLENGE_RE`), `probe-access.ts:200-218` (`classifyBody`).
- **Anti-pattern:** Treating any mention of a WAF-related string as a challenge indicator.

### Cover all vendors: Sucuri, Incapsula, sgcaptcha, Akamai, not just CF
The original UA sweep extracted only `cfRay` and `sgCaptcha` from response headers (`probe-access.ts:621-622`). `fetchForProbe` already returned full headers including `x-sucuri-id`, `x-iinfo`, `server` -- they were present but never read.
- **Example:** gotenda.com returned `x-sucuri-id: 20017` + `server: Sucuri/Cloudproxy` on every UA, but probe output was `hasWaf: null` because Sucuri headers were discarded.
- **Code ref:** `probe-access.ts:616-625` (extraction), lines 742-792 (override block).
- **Anti-pattern:** Adding vendor detection for the most common vendor only and assuming others are rare enough to skip.

### Active vs passive requires browser-UA evidence, not bot-UA 403s
Cloudflare Bot Fight Mode returns 403 to curl/bot UAs on CF-passive sites. This is passive behavior, not an active Managed Challenge. Only a desktop Chrome UA getting 403 + `cf-mitigated: challenge` indicates active CF.
- **Example:** dantesports.com, doubletapsports.com, g4cgunstore.com all wrongly classified as `cloudflare-active` because bot UAs got 403 from Bot Fight Mode.
- **Code ref:** `probe-access.ts` `interpretHeavyProbe()` -- changed `anyChallengeStatus` to `anyChallengeOnBrowserUa`.
- **Anti-pattern:** Treating any 403 on any UA as evidence of active WAF.

### Origin-level rules (mod_security, Wordfence) are not vendor WAFs
Apache mod_security or WordPress Wordfence blocking SQLi/XSS probes does not mean the site needs cookie-solve or special crawler handling. These are origin-level security plugins, not CDN WAFs.
- **Example:** budgetshootersupply.ca, corwin-arms.com, icollector.com, internationalshootingsupplies.com all wrongly flagged `hasWaf=true` because the SQLi/XSS probe batches returned 403 without any vendor header.
- **Code ref:** `probe-access.ts` `interpretHeavyProbe()` -- sqli/xss/honeypot blocking without vendor header now returns `hasWaf=false`.
- **Anti-pattern:** Equating "blocks attack payloads" with "has a WAF that affects normal crawling."

### Subdomain-selective WAF: apex may challenge while www is clean
Some sites have Cloudflare Managed Challenge on the bare apex but not on `www`. The probe must try the www fallback when the apex body contains challenge markers, not just on TCP timeout.
- **Example:** lockharttactical.com apex returns 403 + `cf-mitigated: challenge` on all UAs. `www.lockharttactical.com` returns 200 cleanly. The crawler uses `www.` catalog URLs, so DB correctly says `cloudflare-passive`.
- **Code ref:** `probe-access.ts` `resolveCanonicalOrigin()` -- extended to try www when apex body has challenge markers.
- **Anti-pattern:** Only trying www fallback on `r.status === null` (TCP timeout), missing 403-challenge responses.

---

## 3. Code Discipline

### Reuse existing regexes and detection branches
`WAF_BODY_CHALLENGE_RE` at `probe-access.ts:106` and `classifyHeavyProbe` vendor branches at lines 316-430 already contain the detection logic. Adding Sucuri/Incapsula overrides to the UA-sweep block was 10-15 lines each, following the existing sgcaptcha block pattern at lines 755-768.
- **Anti-pattern:** Creating a new `vendor-signals.ts` module with `extractVendorSignals()` when 4 lines of header reads inline in `runUaProbe` suffice.

### Reuse existing services
`fetchForProbe`, `fetchWithPlaywright`, `extractCatalogProducts`, `heavy-waf-probe.sh` all exist and work. The heavy-waf-probe bash script works on Windows (Git Bash 4.4.23) -- manual runs returned 7365+ bytes on multiple sites. The 13/20 test-run failures were environmental, not a bash-is-broken signal.
- **Anti-pattern:** Proposing a full Node rewrite of `heavy-waf-probe.sh` based on one bad test run.

### Additive changes only
The shipped fix added 4 fields to `UAResult`, 3 override blocks to the UA-sweep verdict section, and 1 www-fallback branch to `resolveCanonicalOrigin`. No interfaces were replaced, no files were created, no modules were added. Total: ~100 net insertions, tsc clean.
- **Anti-pattern:** Replacing `interpretHeavyProbe()` with `synthesizeWafVerdict()`, replacing `UAResult` with a `VendorSignals` sub-object, creating a new shared file.

### tsc clean after every edit
No exceptions. The 5-family baseline (canadafirstammo, aagcanada, theammosource, bullseyenorth, gunpost) must pass after every change.

---

## 4. Verification

### Personally curl the site
Do not relay an agent's claim of "I verified" as your own verification. Run `curl -sI https://site.com/` and read the headers yourself. Check `server:`, `cf-ray:`, `x-sucuri-id:`, `sg-captcha:`, `x-iinfo:` headers. Check body for challenge markers.
- **Example:** The drift-v1 report initially called 3 sites "operator exceptions" based on the convention that `hasWaf=false` for CF-passive is deliberate. Live curl proved 2 of those (alflahertys, doctordeals) were actually wrong-vendor Mistake 35 entries, not operator exceptions at all.
- **Anti-pattern:** Writing "verified" in a report when only an agent ran the check.

### Every drift needs headers + body + heavy-probe evidence before reclassification
A single field disagreement between probe and DB is not enough to reclassify. Capture: (1) response status, (2) all WAF-relevant headers, (3) first 2KB of body, (4) heavy-probe output if available. Document per-site as done in `_phase1-drift-v2.md`.
- **Anti-pattern:** Reclassifying based on a single header or a single UA response.

### Heavy-probe bash failures are usually transient under sequential-run IP pressure
13/20 sites failed in the first sequential test run. All 13 succeeded in individual re-runs. The pattern was environmental (process pool exhaustion, sequential IP pressure), not a fundamental bash-on-Windows issue. Adding error logging (`e.code`, `e.signal`, `e.killed`, `e.stderr`) is the correct response, not rewriting to Node.
- **Anti-pattern:** Declaring "bash is broken on Windows" and proposing a full rewrite after one bad batch run.

### 5-family baseline must pass after every change
canadafirstammo (WooCommerce/CF), aagcanada (Shopify/CF), theammosource (BC Stencil/CF), bullseyenorth (Celerant/no-WAF), gunpost (Drupal/CF-active). No regressions allowed.

---

## 5. DB and Site Profiles

### DB is a persisted claim, not automatic truth
The DB stores what someone believed at write time. 9 out of 65 sites had DB entries that disagreed with live evidence. In every case, live was correct and DB was stale.
- **Example:** alflahertys.com had `wafType=sucuri` from bulk onboarding (Mistake 35). Live curl showed `server: cloudflare`, `cf-ray`, zero Sucuri markers. doctordeals.ca same pattern -- `wafType=sucuri` but actually sgcaptcha.
- **Anti-pattern:** Treating "probe disagrees with DB" as "probe is wrong."

### When live disagrees with DB, verify fresh, then fix DB
Do not invent euphemisms like "fleet drift" or "operator exception" to explain away disagreements. Verify live with fresh curl, document the evidence, propose DB correction.
- **Example:** sail.ca had `hasWaf=true, wafType=none` -- internally contradictory. Live showed Fastly CDN only, zero WAF vendor headers. Correct state: `hasWaf=false`.

### DB writes: dry-run first, per-record BEFORE/AFTER log, re-read verify
When correcting DB entries, log what was there before, what you're changing it to, and read it back after. The session identified 9 corrections needed but made zero DB writes -- all deferred to the user's admin UI.

### Two fields per WAF correction
`monitoredSite.hasWaf` (boolean column in the DB table) AND `siteProfile.wafType` (JSON field). Setting only the profile field does NOT affect the crawler -- `crawl-scheduler.ts:209,282,576` reads `site.hasWaf` (the column), not the profile.
- **Code ref:** `backend/src/services/crawl-scheduler.ts:209,282,576`.

---

## 6. Process

### Invoke `using-superpowers` skill every single turn
Not once per session. The skill checks for relevant skills/agents before responding. Multiple turns in this session skipped it, leading to direct work instead of proper agent delegation.

### Use the proper expert agent for non-trivial work
The code-reviewer agent caught that Action 8 was a no-op and Action 7 was untestable -- issues the implementing agent missed. Skeptical review between plan and implementation is not optional.
- **Anti-pattern:** Taking the task yourself when the expert agent is available.

### When an agent stalls, spawn fresh or wake via SendMessage
Do not take over the agent's work. The agent has context the direct approach will miss.

### Save intermediate evidence files, clean up scratch scripts after
The session produced `_phase1-architecture.md`, `_phase1-minimal-plan.md`, `_phase1-plan-review.md`, `_phase1-drift-v2.md`, `_phase1-report.md` -- all useful evidence. Scratch test scripts should be cleaned up before committing.

---

## 7. Honest Reporting

### Don't say "I verified" when only an agent did it
If an agent ran the curl and reported the headers, say "agent reported" not "verified."

### Don't hide disagreements with a "fleet drift" euphemism
The drift-v1 report labeled 3 CF-passive `hasWaf=false` sites as "operator exceptions" and 2 wrong-vendor sites as "fleet drift." After live verification (drift-v2), the correct breakdown was: 3 operator conventions, 5 stale DB entries, 1 probe design limitation, 0 fleet drift.
- **Anti-pattern:** Using "fleet WAF drift" to avoid saying "DB is wrong."

### "Stale transient" claims need evidence
Claiming 13/20 heavy-probe failures were "transient network" is possible but not proven. The re-runs succeeded at different times under different conditions. The code-reviewer correctly flagged this as "partially rejected."

### Admit regex over-matches and fix them
`cdn-cgi/challenge-platform` in real content falsely flagged pages as challenges. Acknowledge the over-match, narrow the regex, and add a size/status guard.

---

## 8. Concrete Mistakes That Burned Time (Don't Repeat)

- **Gap C keyword-match testUrl heuristic** — originally added to `pickTestUrl` in `pre-bootstrap.ts` (firearms-specific `PRODUCT_LISTING_SIGNAL` regex matching `/firearm|rifle|shotgun|hunting|gun/i`). Was rejected by user as "guessing." Later REPLACED with async empirical extraction per Playbook Step 3d (see `pre-bootstrap.ts:128` — `pickTestUrl` now runs `runProbeExtraction` on top candidates, picks one with highest product count). Lesson: the playbook already specifies the correct methodology; don't invent novel heuristics.
- **`vendor-signals.ts` over-engineering plan** (`_phase1-architecture.md`) -- proposed new file, new interface with 7 sub-objects, new `extractVendorSignals()` function, new `synthesizeWafVerdict()`, full Node rewrite of heavy-waf-probe.sh. Rejected by code-reviewer. Correct fix was 4 inline field additions + 3 override blocks.
- **Claimed "fleet WAF drift"** on alflahertys (sucuri->CF), doctordeals (sucuri->sgcaptcha), sail.ca (hasWaf=true+wafType=none) -- all were stale DB entries, not drift.
- **Relayed agent's "I verified" as own verification** on multiple drift assessments. Had to re-verify all 9 drifts with fresh curls in drift-v2.
- **Under-detected lockharttactical** because probe tested apex not www. Apex returns 403+cf-mitigated on all UAs; www is clean. Fix: www fallback on challenge body, not just TCP timeout.
- **Over-classified CF active** on dantesports, doubletapsports, g4cgunstore because curl/bot UAs got 403 from Bot Fight Mode. Fix: only desktop UA 403 + `cf-mitigated` counts as active.
- **Treated mod_security/Wordfence as WAFs** on budgetshootersupply, corwin-arms, icollector, internationalshootingsupplies. Fix: sqli/xss blocking without vendor header = `hasWaf=false`.
- **Regex over-match:** `cdn-cgi/challenge-platform` in real content falsely flagged as challenge. Needed body-size + status guard.
- **Heavy-waf-probe "bash broken on Windows"** hypothesis after 13/20 test-run failures. Manual runs proved bash works fine. Turned out to be transient environmental issue under sequential batch execution.
- **Skipped `using-superpowers`** invocation on multiple turns, leading to direct work instead of proper agent delegation.
