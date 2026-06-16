---
name: close
description: "Run only when explicitly invoked. Klawde close protocol: record decisions and scope changes to CHANGES.md and update BRIEFING.md before ending work."
---

# /close: Session Close Protocol

Run this at the end of a session to persist state for the next session.

## Steps

1. Read the current `CHANGES.md` and `BRIEFING.md`. If either is missing, create it first using the formats in `.agents/skills/klawde/SKILL.md`, then continue.

2. Review all work done in this session. For each unrecorded shift in decisions, plans, scope, documents, external context, or code needing project-level explanation:
   - Append a line at the bottom of `CHANGES.md`: `{today} [type] description` (one line, max 200 chars). Substitute `{today}` with today's ISO date before writing.
   - Types: `decision`, `plan`, `doc`, `scope`, `code`, `note`

3. Review whether any of the following changed during this session:
   - Project purpose or scope
   - Key architectural or design decisions
   - Non-goals or explicit exclusions
   - Breaking changes (note reason and impact)

   If any of the above changed, update `BRIEFING.md` accordingly. An empty field in `BRIEFING.md` (e.g., Purpose) counts as changed: draft it from what this session revealed. Keep it concise but sufficient to brief a new contributor; match the example brief in `.agents/skills/klawde/SKILL.md`.

4. Write only the file(s) you changed. If neither changed, do not write. Do not stage or commit. Leave changes dirty so the user controls when they enter git history.

5. Output exactly this format, then stop:

```
Session closed.
CHANGES.md: [number] new entries appended.
BRIEFING.md: [updated | unchanged].
```

Do not skip this protocol. If nothing recordable changed, say so and confirm both files are unchanged.
