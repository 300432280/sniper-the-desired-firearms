# Release Plan: Site Profile Modularity System

**Date:** 2026-03-29
**Status:** APPROVED — Ready for implementation
**Plan file:** C:\Users\TNT\.claude\plans\wild-gathering-kitten.md (full details)

## Summary
Move ALL site-specific behavior from hardcoded adapter code into per-site JSON profiles (siteProfile column on MonitoredSite). 39 sites have hardcoded domain checks scattered across 5+ files. Each site gets a SiteProfile containing: platform type, crawler config (bootstrap/maintain methods, API endpoints, data flow steps), URLs, WAF settings, custom selectors, and structural notes.

## Key Points
- Generic adapters read from profile — zero site-specific code in adapters
- Each profile documents HOW the site provides data (e.g., gotenda: WP REST for discovery, Store API for price enrichment)
- Profiles are independently maintained per site — change one without affecting others
- Admin approval required for maintain phase transition — no auto-transition
- Maintain cooldowns: T2=3h, T3=5h, T4=9h
- Wanted items preserved separately (category='wanted') when deleted
- All existing crawler features already deployed — only implement NEW modularity

## Implementation Order
1. Schema: add siteProfile Json column
2. Create site-profile.ts helper
3. Migration: extract 39 hardcoded configs into profiles
4. Modify adapters to read from profile
5. Remove hardcoded domain checks (verify functionality first!)
6. Test all 39 sites
7. Update README
