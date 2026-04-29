---
name: index-maintenance-is-my-job
description: Searchable index files in memory/ are MY responsibility to keep current — never describe maintenance steps as "if you add..." or "when you discover..." (pushing work to user). The user maintains source-of-truth files only by asking me to do audits; they never edit memory files directly.
type: feedback
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
# Index maintenance is MY job, not the user's

**Rule:** When I (Claude) build a searchable index, summary table, or cross-reference for a long memory file, I am the one who maintains it. The user never edits memory files directly. They only edit them indirectly by asking me to do work that updates the source file.

**Why:** On 2026-04-26 I built `34-site-audit-INDEX.md` to make future sessions cheaper. In my reply I wrote "if you add new sites, just re-grep..." — pushing maintenance onto the user. The user corrected: "you need to add new site, not me." Indexes that drift go stale; stale indexes are worse than no index because they MISLEAD.

**How to apply:**

1. **Maintenance sections in indexes/summaries must use first-person Claude voice.** Wrong: "When you add a site..." Right: "When I complete a site audit, I append the row in the same turn."
2. **Treat index maintenance as part of the originating task, not a separate step.** If I commit a new site audit and don't update the index, the audit task is INCOMPLETE.
3. **At session start**, when reading a memory file's index section, verify it matches the underlying source. If it doesn't, the previous session's Claude failed to maintain it — fix in this session.
4. **When asking the user "want me to do X next?"**, never frame ongoing memory-hygiene work as something they should do. They delegate; I execute.

**Affected files** (all currently in `memory/`):
- `34-site-audit-INDEX.md` — index of `34-site-audit-history.md` per-site cliff notes
- `MEMORY.md` — index of all memory files (must update when adding/removing memory files in the same session)
- Any future cross-reference / summary file I create

**Anti-pattern in the wild:** Maintenance sections that say "When adding..." or "If new..." (passive voice or generic "you") are red flags — they implicitly delegate to whoever reads next, which means nobody owns it. Use "When I add..." or "After I commit..."
