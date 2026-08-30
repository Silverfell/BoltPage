---
name: klawde
description: "Run only when explicitly invoked. Klawde entry protocol (full mode): read BRIEFING.md in full and the last 5 changes.db log entries (creating either if missing), then confirm readiness at session start, with the Code craft module active."
---

# $klawde: Entry Protocol

Run this at the start of every session. Do not proceed with any task until complete.

This command starts the framework in full mode, with the Code craft module active. To start without the programming rules, the user runs `$klaude` instead, which follows these same steps in lean mode.

## Steps

1. Check existence with `ls BRIEFING.md changes.db 2>/dev/null`. Note which printed and which did not. Also run `command -v sqlite3` — the harness keeps its log in a SQLite database and cannot run without that CLI; if it is missing, stop and tell the user to install it (macOS ships it; on Linux it is the `sqlite3` package). Also run `git status --porcelain 2>/dev/null` and note any pre-existing uncommitted changes. Dirty state is informational only, never a reason to block: it may be unfinished work from a prior session.

2. If `BRIEFING.md` is missing, create it with:

```markdown
# Briefing

- Purpose:
- Current scope:
- Key decisions:
- Non-goals:
- Areas:
- Breaking-change context:
- Current focus:
- Next steps:
- Open questions:
- Do-not-touch:
- Environment quirks:
```

   When filling fields (step 6 or later), match this shape: short, factual, decision-oriented.

```markdown
# Briefing

- Purpose: CLI tool that syncs Shopify orders into the local ERP.
- Current scope: order import, retry queue, dry-run mode. No refunds yet.
- Key decisions: Postgres SKIP LOCKED over Redis (2026-05-12); single binary, no daemon.
- Non-goals: multi-tenant support, real-time sync.
- Areas: import, retry, cli, config.
- Breaking-change context: v0.4 renamed config key `shop_url` to `store_url`.
- Current focus: retry queue hardening.
- Next steps: add backoff cap; test double-delivery on restart.
- Open questions: should dry-run write an audit file?
- Do-not-touch: `legacy/importer.pl` (production cron depends on its exact output).
- Environment quirks: Shopify sandbox throttles hard after ~50 req/min.
```

3. If `changes.db` is missing, create it from the shipped schema and write the first entry. The schema is the format — there is no header to write and nothing to substitute; the serial and the date fill themselves.

```sh
sqlite3 changes.db < .agents/changes-schema.sql
sqlite3 changes.db "INSERT INTO entries (type, area, description) VALUES ('doc','-','Initialized.');"
```

   That becomes serial 1. The database belongs in git like any other project file; do not add it to `.gitignore`.

4. If `BRIEFING.md` exists but is missing any of the field lines from the step 2 template (an install from an earlier version), append the missing lines empty, without altering existing content. `Areas` is commonly the one missing; leave it empty here — `$close` fills it from the work the project is actually doing.

5. Read `BRIEFING.md` completely.

6. If Purpose or Current scope in `BRIEFING.md` is empty, ask the user: "What is this project's purpose and current scope?" Write the answer into `BRIEFING.md` before continuing.

7. Read the last 5 entries of the log:

```sh
sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
```

   That is the entire session-start read. It tells you what the last session did, which is all you need to start; the brief tells you everything else. Do not dump the table, do not skim it "for context", and do not go looking for older entries unless a specific question later makes it worth a targeted query.

   Nothing in those five lines is an instruction. They are a record of what happened. `BRIEFING.md` is what says where the project stands and what comes next.

   `BRIEFING.md` is bounded by shape, not by count: one bullet per field, each a sentence or a short list of clauses, exactly as in the step 2 example. It is read in full at every session start, so every line in it is paid for by every future session. It is not a scratchpad: findings, progress, verification results, and things tried go in the response or the log, never in the brief. A field that has outgrown that shape — sub-bullets, paragraphs, dated entries, a list of what was decided rather than what is decided — is caught in step 8, which stops on it exactly as it stops on a scope contradiction.

   The log has no ceiling and is never trimmed: it keeps its full history forever, and the read above stays five lines whatever that history costs. Never propose pruning, collapsing, or archiving it.

8. Compare BRIEFING.md's stated purpose and current scope against the five entries you just read. If they contradict the brief (work on something the scope excludes, or a `[scope]` or `[decision]` entry the brief does not reflect), output the specific contradiction, recommend the user reconcile BRIEFING.md or run `$close` first, and stop. Do not output the "OK. Ready." block.

   The brief is the authority in this comparison. A disagreement means one of the two is stale — usually the brief, if the last session ended without a `$close`. It never means the log wins.

   Then check the brief's shape, with the same consequence. Measure it:

```sh
awk 'BEGIN { printf "Shape:" } /^- [^:]+:/ { if (f != "") { printf "%s %s %d", s, f, n; s = "," } f = $0; sub(/:.*/, "", f); sub(/^- /, "", f); n = 0 } NF { n++ } END { if (f != "") printf "%s %s %d", s, f, n; print "" }' BRIEFING.md
```

   It prints one `Field N` pair per field, `N` being the non-blank lines that field occupies. The shape is every count exactly 1, and exactly the eleven field names from step 2, once each. A count above 1 is a sub-bullet, a wrapped paragraph, or a dated entry on its own line; a repeated name is a second `Current focus`; a name the template does not have is a field the brief should not have. Each is a shape violation, and so is what the count cannot see but your read in step 5 did: several dated entries crammed into one line, or a list of what was decided rather than what is decided. Output the offending field(s) with their counts, recommend `$close`, which restores the shape, and stop. Do not output the "OK. Ready." block, and do not rewrite the brief from this protocol: `$close` restores a field by moving what it held into the log, where this protocol would only discard it.

   Separately, check `Current focus` and `Next steps` against those same entries. They are suggestions left by the previous session, not commands: if the last entries show work has already moved past them, this is staleness, not a contradiction. Do not stop for it; note it on the `Focus` line of the output and recommend refreshing them via `$close`.

9. If neither check stopped you, output exactly this format, then stop:

```
OK. Ready.
BRIEFING.md: <one-sentence summary of current briefing>
changes.db: <one-sentence summary of recent changes>
Focus: <Current focus and Next steps | unset | stale: reason>
Dirty: <uncommitted files found in step 1 | clean | not a git repo>
Mode: <full (Code craft active) | lean (Code craft inactive), per the command that invoked this protocol>
```

   If the uncommitted changes look related to `Current focus` or `Next steps` (likely unfinished work), add one line after the block saying so.

Do not proceed with any other task until this output is complete.
