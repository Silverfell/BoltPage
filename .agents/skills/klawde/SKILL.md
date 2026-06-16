---
name: klawde
description: "Run only when explicitly invoked. Klawde entry protocol: read or create BRIEFING.md and CHANGES.md and confirm readiness at session start."
---

# /klawde: Entry Protocol

Run this at the start of every session. Do not proceed with any task until complete.

## Steps

1. Check existence with `ls BRIEFING.md CHANGES.md 2>/dev/null`. Note which printed and which did not.

2. If `BRIEFING.md` is missing, create it with:

```markdown
# Briefing

- Purpose:
- Current scope:
- Key decisions:
- Non-goals:
- Breaking-change context:
```

   When filling fields (step 5 or later), match this shape: short, factual, decision-oriented.

```markdown
# Briefing

- Purpose: CLI tool that syncs Shopify orders into the local ERP.
- Current scope: order import, retry queue, dry-run mode. No refunds yet.
- Key decisions: Postgres SKIP LOCKED over Redis (2026-05-12); single binary, no daemon.
- Non-goals: multi-tenant support, real-time sync.
- Breaking-change context: v0.4 renamed config key `shop_url` to `store_url`.
```

3. If `CHANGES.md` is missing, create it. Substitute `{today}` with today's ISO date (e.g. 2026-05-21) before writing:

```markdown
# Changes

Format: `YYYY-MM-DD [type] description` (max 200 chars). Types: decision, plan, doc, scope, code, note.

{today} [note] Initialized.
```

4. Read `BRIEFING.md` completely.

5. If Purpose or Current scope in `BRIEFING.md` is empty, ask the user: "What is this project's purpose and current scope?" Write the answer into `BRIEFING.md` before continuing.

6. Read `CHANGES.md` (at least the last 30 lines).

7. Compare BRIEFING.md's stated purpose and current scope against the last 30 lines of CHANGES.md. Treat it as drift when either:
   - three or more recent entries concern work on something absent from Current scope, or
   - a `[scope]` or `[decision]` entry is not reflected in the brief.

   If drift, output the contradiction, recommend the user reconcile BRIEFING.md or run `$close` first, and stop. Do not output the "OK. Ready." block.

8. If no drift, output exactly this format, then stop:

```
OK. Ready.
BRIEFING.md: <one-sentence summary of current briefing>
CHANGES.md: <one-sentence summary of recent changes>
```

Do not proceed with any other task until this output is complete.
