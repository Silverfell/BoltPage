---
name: klawde
description: Start a klawde session. Reads the brief, the last five log entries and the open tasks, creating the records on first run.
disable-model-invocation: true
---

# klawde: Entry Protocol

Run at session start. Complete this protocol before any other task, then stop. The contract's Records, The log, Tasks, The brief and Writing to the records sections define the shared rules.

Commands run at the project root, where the project files are (BRIEFING.md, changes.db, guidelines.md, klawde-sql.md). `<skill>` is the full path of the folder holding this file; replace it in every command.

## Steps

1. Check the contract version:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   If it matches, continue. Otherwise stop: when the same command with `v[3-9]` in place of `v2` matches, say "The contract is newer than this harness; run upgrade.sh."; else say "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry."

2. Run `ls BRIEFING.md changes.db 2>/dev/null` and note which exist. Run `command -v sqlite3`; if it is missing, stop and request installation of the SQLite CLI. Run `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git status --porcelain`, noting a non-repository; dirty state is reported and entry continues.

3. If `BRIEFING.md` is missing, create the empty four-field form:

```markdown
# Briefing

- Purpose:
- Scope:
- Key decisions:
- Areas:
```

4. If `changes.db` is missing, first confirm `<skill>/changes-schema.sql` exists; if it is absent, stop and say the klawde install is incomplete: run upgrade.sh. Then create the database:

```sh
sqlite3 -bail changes.db < <skill>/changes-schema.sql
```

   Commit it like any other project file; never add it to `.gitignore`.

5. Read the schema version of `changes.db` before reading anything else from it, and the version this harness ships:

```sh
sqlite3 -readonly changes.db "PRAGMA user_version;"
grep -o 'user_version = [0-9]*' <skill>/changes-schema.sql
```

   - Equal: continue.
   - 0: the database was never initialized. Stop. "changes.db exists but holds no schema; remove it and run the `klawde` command again."
   - Below the shipped version: stop. "changes.db is schema v<N>; run the `upgrade_klawde` command to migrate it."
   - Above the shipped version: stop. "changes.db is newer than this harness; run upgrade.sh."

6. Read `BRIEFING.md` completely.

7. Read `guidelines.md` if it exists. If it does not, continue and say nothing about it.

8. If `Purpose` or `Scope` is empty, ask "What is this project's purpose and scope?", wait for the answer, and write it before continuing. An answer the user already gave this session is used as given. Done when both fields hold a line the user gave.

9. Read the tail and the open tasks into context:

```sh
sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
sqlite3 -readonly changes.db "SELECT line FROM task_lines ORDER BY id;"
sqlite3 -readonly changes.db "SELECT count(*) FROM tasks;"
```

10. Output this format, then stop:

```
OK. Ready.
BRIEFING.md: <one sentence: what this project is and what it is for>
Tasks: <the measured count> open
Dirty: <uncommitted files | clean | not a git repo>
```

Print nothing else from the log or the tasks.
