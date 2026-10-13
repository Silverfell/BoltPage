---
name: close
description: "Run only when explicitly invoked. Klawde close protocol: append what was done to the changes.db log, clear completed tasks, and update BRIEFING.md where this session changed what it states."
---

# $close: Session Close Protocol

Persist state at session end or as a mid-session checkpoint. Cleanup and sweep only: no `git status`, `git diff` or `git log` reconstruction. The contract's The log, Tasks, The brief and Writing SQL safely sections define the shared rules.

## Steps

1. Read `BRIEFING.md` completely. Check the schema version exactly as step 4 of `.agents/skills/klawde/SKILL.md` does, and stop the same way; then read the last five entries:

```sh
sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
```

   If either record is missing, create it with the forms in `.agents/skills/klawde/SKILL.md`. If the schema file is missing, stop and recommend `upgrade.sh` from the klawde checkout.

2. **Sweep.** Anything finished and verified this session that is not in the log gets its entry now, under the contract's three types. Any approved task completed this session that still has a row gets its `done` entry and its row deleted. When nothing qualifies, write nothing.

   Record the last serial before the inserts and read the tail afterwards for the closing range.

3. **Brief.** Update a field only where this session changed the fact it states, under the contract's write rules. Never complete a proposed edit while its answer is pending.

4. Measure the open tasks; never tally them yourself:

```sh
sqlite3 -readonly changes.db "SELECT count(*) FROM tasks;"
```

5. Output this format, then stop:

```
Session closed.
changes.db: <N new entries (serials X-Y) | none>
Tasks: <N open | none>
BRIEFING.md: <updated: <field>: "<the new line>" | unchanged>
```

   Paste the measured numbers, never expected values. When nothing changed, print only the block: no questions, no follow-up ideas.
