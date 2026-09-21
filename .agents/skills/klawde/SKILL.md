---
name: klawde
description: "Run only when explicitly invoked. Klawde entry protocol: read BRIEFING.md in full, guidelines.md if present, the last 5 changes.db log entries and the open tasks, creating the records if missing, then confirm readiness at session start."
---

# $klawde: Entry Protocol

Run at session start. Complete this protocol before any other task, then stop. The contract's Records, The log, Tasks, The brief and Writing SQL safely sections define the shared rules.

## Steps

1. Run `ls BRIEFING.md changes.db 2>/dev/null` and note which exist. Run `command -v sqlite3`; if it is missing, stop and request installation of the SQLite CLI. Run `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git status --porcelain`, noting a non-repository; dirty state never blocks entry.

2. If `BRIEFING.md` is missing, create the empty four-field form:

```markdown
# Briefing

- Purpose:
- Scope:
- Key decisions:
- Areas:
```

3. If `changes.db` is missing, first confirm `.agents/changes-schema.sql` exists; if it is absent, stop and recommend `upgrade.sh` from the klawde checkout. Then create the database:

```sh
sqlite3 -bail changes.db < .agents/changes-schema.sql
```

   Commit it like any other project file; never add it to `.gitignore`.

4. If `changes.db` is present, read the schema version before reading anything else from it:

```sh
sqlite3 -readonly changes.db "PRAGMA user_version;"
```

   - 8: continue.
   - 1 to 7: stop. "changes.db is schema v<N>; run `$upgrade_klawde` to migrate it."
   - 0: the database was never initialized. Stop. "changes.db exists but holds no schema; remove it and run `$klawde` again."
   - above 8: stop. "changes.db is newer than this harness; update the klawde checkout."

5. Read `BRIEFING.md` completely.

6. Read `guidelines.md` if it exists. If it does not, continue and say nothing about it.

7. If `Purpose` or `Scope` is empty, ask "What is this project's purpose and scope?", wait for the answer, and write it before continuing. An answer the user already gave this session needs no second ask.

8. Read the tail and the open tasks:

```sh
sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
sqlite3 -readonly changes.db "SELECT line FROM task_lines ORDER BY id;"
```

9. Output this format, then stop:

```
OK. Ready.
BRIEFING.md: <one sentence: what this project is and what it is for>
Log:
<the five lines, newest first, verbatim | none>
Tasks:
<the open task lines, verbatim | none>
Dirty: <uncommitted files | clean | not a git repo>
```

No summary of the log: print the lines.
