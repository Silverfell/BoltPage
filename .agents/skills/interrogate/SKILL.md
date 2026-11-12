---
name: interrogate
description: Interview a plan, decision or idea in rounds until nothing is assumed; records change only on your word.
argument-hint: "<plan, decision or idea; empty for the one under discussion>"
disable-model-invocation: true
---

# interrogate: Interview Protocol

Interview the user until the subject has no unstated assumption left. Facts are yours to find; decisions are the user's. Nothing is built and nothing is written to the records during the interview.

## Steps

1. Check the contract version before anything else:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   No match: stop. "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry." If the same command with `v[3-9]` in place of `v2` matches, stop. "The contract is newer than this harness; run upgrade.sh." Done when the check passed or the protocol stopped.

2. **Subject.** The subject is the text given with the command, else the plan, decision or idea under discussion. When there is neither, ask "What should I interrogate?" and wait. Done when the subject is stated back in one sentence at the top of round 1.

3. **Tree and frontier.** Map the subject as a design tree: every decision branches into the decisions that hang off it. The frontier is every decision whose prerequisites are settled. A question whose answer depends on another question still open belongs to a later round. When the tree is plainly larger than one session, say so in one line and offer to split it; the user decides. Done when the frontier is known and no question on it depends on another open question.

4. **Facts first.** Settle every fact a frontier question needs before the round is posted. A fact found in one file or one command is looked up now: `BRIEFING.md`, `guidelines.md`, the repository, command output, a targeted read of `changes.db`. A wider lookup goes to a background subagent with the question and the paths to read, returning the answer and the files it rests on. Where the harness offers no subagents, do this inline in the same form, before the round. A running lookup is an unsettled prerequisite: the questions downstream of it wait, and the rest of the frontier is asked now. A fact is never asked of the user. Done when every question rests only on settled facts or on the user's choice.

5. **Round.** Ask the whole frontier, numbered, with your recommended answer under each question, worded so "yes" accepts it. Stop and wait. Form:

```
Round <N>

Q<n>. <title>: <question, with the options where there are options>
Recommended: <answer>
```

   One blank line between questions. Plain text, no emoji. The user may answer by number.

6. **Recompute.** The answers settle decisions. Recompute the frontier from scratch and return to step 4. An answer you supplied yourself, or an assumption nobody stated, is not a settled decision. When an answer shows an earlier decision was wrong, reopen that branch in the next round and say so. Done when the next round is posted or the frontier is empty.

7. **Done.** When the frontier is empty, list the settled decisions, one line each, and ask the user to confirm the shared understanding. Wait. Build nothing and write nothing until the user confirms. Done when the user has confirmed or said what to change; a change returns to step 4.

8. **Record, on the user's word.** If `BRIEFING.md` or `changes.db` is missing, skip this step and say "No session docs found; run the `klawde` command to enable continuity." Otherwise propose each record write as the exact line with its home:

   - an architectural directive: a `Key decisions` line in `BRIEFING.md`;
   - approved work not yet done: a `tasks` row;
   - a choice the code, its comments and the documentation do not show: a `decided` entry.

   Write only what the user approves. SQL writes use the forms in `klawde-sql.md` at the project root, read before the first write; every identifier printed is the one read back from the database in the same statement. "Nothing to record" is a normal outcome; say it. Done when every proposed line has an answer and every approved line is written.

9. Output this format, then stop:

```
Interrogation complete.
Settled: <one line per decision | none>
Recorded: <BRIEFING.md Key decisions: "<line>" | tasks #<id> | entries <serial> | nothing>
```

   Identifiers are the values read back from the database, never expected values.
