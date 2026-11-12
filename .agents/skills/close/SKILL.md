---
name: close
description: Close a klawde session. Logs finished work, deletes completed tasks, updates a brief field whose fact changed.
disable-model-invocation: true
---

# close: Session Close Protocol

Persist state at session end or as a mid-session checkpoint. Sweep only: the conversation is the source, with no git reconstruction. The contract's The log, Tasks, The brief and Writing to the records sections define the shared rules; writes use the forms in `klawde-sql.md` at the project root.

Commands run at the project root, where the project files are (BRIEFING.md, changes.db, klawde-sql.md). `<skill>` is the full path of the folder holding this file; replace it in every command.

## Steps

1. Check the contract version:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   If it matches, continue. Otherwise stop: when the same command with `v[3-9]` in place of `v2` matches, say "The contract is newer than this harness; run upgrade.sh."; else say "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry."

2. Run `ls BRIEFING.md changes.db 2>/dev/null`. If either record is missing, stop and say "Run the `klawde` command first; it creates the records." Read `BRIEFING.md` completely. Read the schema version of `changes.db` and the version this harness ships:

```sh
sqlite3 -readonly changes.db "PRAGMA user_version;"
grep -o 'user_version = [0-9]*' <skill>/../klawde/changes-schema.sql
```

   Equal: continue. Otherwise stop: at 0, "changes.db exists but holds no schema; remove it and run the `klawde` command."; below the shipped version, "changes.db is schema v<N>; run the `upgrade_klawde` command to migrate it."; above it, "changes.db is newer than this harness; run upgrade.sh." Then read the last five entries:

```sh
sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
```

3. **Sweep.** Anything finished and verified this session and still absent from the log gets its entry now, under the contract's three types. Any approved task completed this session that still has a row gets its `done` entry and its row deleted. When nothing qualifies, write nothing.

   Record the last serial before the inserts and read the tail afterwards for the closing range. Done when every finished and verified piece of this session's work has an entry and no completed task has a row.

4. **Brief.** Update a field only where this session changed the fact it states, under the contract's write rules. Done when every field states what is true now and every proposed edit has an answer or stays unwritten.

5. Measure the open tasks:

```sh
sqlite3 -readonly changes.db "SELECT count(*) FROM tasks;"
```

6. Output this format, then stop:

```
Session closed.
changes.db: <N new entries (serials <X>-<Y>) | none>
Tasks: <N open | none>
BRIEFING.md: <updated: <field>: "<the new line>" | unchanged>
```

   Every number in the block is pasted from command output. When nothing changed, the block is the whole reply.
