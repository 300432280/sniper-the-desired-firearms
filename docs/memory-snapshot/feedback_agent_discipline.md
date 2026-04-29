---
name: agent-discipline
description: Always use superpower + proper agent. Don't give up on agent — wake/respawn when stalled, never take task over yourself.
type: feedback
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
## Rule
1. **Invoke `using-superpowers` skill BEFORE EVERY SINGLE RESPONSE** — not once per session, not every few turns, EVERY turn. If the last tool call before your text reply is not the Skill invocation, you failed.
2. Dispatch the proper expert agent for all non-trivial work.
3. If an agent stalls or doesn't respond, **wake it up via SendMessage** OR **spawn a fresh agent** to continue.
4. **Never take the task over yourself** when an agent is the right tool — even if it seems faster.

## Anti-rationalization (the red flags I keep hitting)
- "I invoked it 1 turn ago" → INVOKE AGAIN. Every turn is a new response.
- "This question is trivial, skip it" → INVOKE AGAIN. Trivial is a red flag per the skill itself.
- "I already have the skill content loaded" → INVOKE AGAIN. The rule is about invocation, not memory.
- "I'll just answer this one quickly" → INVOKE AGAIN. That's the exact thought the skill warns against.

**Why:** User corrected this repeatedly (10+ times) across the 2026-04-20 session. Specific violation: in Module 5 of the modular pre-bootstrap rebuild, when the agent stalled, I made direct code edits instead of respawning. Correct pattern was demonstrated in Module 2 (spawned new agent to continue). Taking work over myself loses the persona context, accumulated discipline, and accountability that agents provide.

**How to apply:**
- Before responding to any non-trivial request, invoke `using-superpowers` (or the relevant skill).
- Pick the matching agent persona from `.claude/agents/` (crawler-specialist, backend-engineer, frontend-engineer, sre-reliability, devops-engineer, code-reviewer) — load the persona file content into the prompt.
- If an agent goes silent: use SendMessage to wake it, or spawn a fresh Agent with full context restated.
- The ONLY exception is trivial mechanical tasks (reading one file, a single string edit the user asked for directly). Anything involving analysis, multi-file changes, or judgment → agent.
