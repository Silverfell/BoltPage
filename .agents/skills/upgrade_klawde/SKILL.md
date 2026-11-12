---
name: upgrade_klawde
description: Migrate klawde's records after upgrade.sh. Brings changes.db to the current schema and the brief to its four fields, with your approval per step.
disable-model-invocation: true
---

# upgrade_klawde: Record Migration

Run once, after `upgrade.sh` has copied the new files. This command migrates records. It writes records only; `upgrade.sh` writes the harness files. It is the only protocol allowed to rewrite the log, and it does so once.

Every question about a row is answered before that row is destroyed, and the conversion is a single transaction: it either completes or leaves the log exactly as it was, ready for another run.

Commands run at the project root, where the project files are. `<skill>` is the full path of the folder holding this file; replace it in every command. The schema file is `<skill>/../klawde/changes-schema.sql`.

## Steps

1. Check the contract version:

```sh
cat CLAUDE.md AGENTS.md 2>/dev/null | grep -q '^<!-- klawde:begin v2 '
```

   If it matches, continue. Otherwise stop: when the same command with `v[3-9]` in place of `v2` matches, say "The contract is newer than this harness; run upgrade.sh."; else say "This project's klawde contract is missing or older than this harness (needs v2). Run upgrade.sh from the klawde checkout, then retry."

2. Run `ls BRIEFING.md changes.db 2>/dev/null`. Read the shipped version, and the log's version only if `changes.db` exists:

```sh
grep -o 'user_version = [0-9]*' <skill>/../klawde/changes-schema.sql
sqlite3 -readonly changes.db "PRAGMA user_version;"
```

   Take exactly one branch:

   - Neither record exists → nothing to migrate. Recommend the `klawde` command. Stop.
   - `changes.db` absent, `BRIEFING.md` present → create the log first, so the brief's work has somewhere to go, then skip to step 6:

```sh
sqlite3 -bail changes.db < <skill>/../klawde/changes-schema.sql
```

   - `changes.db` present, its version compared with the shipped one:
     - 0 → it holds no schema. Stop: "remove changes.db and run the `klawde` command."
     - above → stop: the project is newer than this harness; run upgrade.sh.
     - equal → the log is already migrated. Skip to step 6.
     - below → continue with steps 3 to 5.

3. Copy the database before any write, and say where the copy is:

```sh
cp changes.db changes.db.pre-migration.$(date +%Y%m%d-%H%M%S)
```

   Done when the copy exists and its path has been printed.

4. **Concerns, decided before anything is destroyed.** Read what the old log holds:

```sh
sqlite3 -readonly changes.db ".schema concerns"
```

   If it prints nothing, there is no `concerns` table: skip to step 5. Otherwise read the open rows, leaving out `, evidence` when the definition has no such column:

```sh
sqlite3 -readonly changes.db "SELECT id, concern, evidence FROM concerns WHERE resolved IS NULL ORDER BY id;"
```

   Show every open row. Then ask about all of them in one numbered round, `Q<n>. <question>` with `Recommended: <answer>` beneath: one question per row, `Recommended: task` when the row names unfinished work the user approved, `Recommended: drop` otherwise, each worded so "yes" accepts. Wait for the answers. Each row carries over only on the user's word. Resolved concerns go with the table. Ask here, while the table still exists: the round is safe to interrupt, because the next run reads the old version and asks again. Done when every open row has an answer, task or drop.

5. **Migrate, in one transaction.** Serials and dates are preserved; every entry becomes `done`; a non-null `refs` value is appended to the description in parentheses, untruncated — the triggers arrive after the copy, so a long row is fine. Views are dropped before the rename; every drop is `IF EXISTS`, since older logs lack some of these objects.

   Everything is in the transaction, including the tasks approved in step 4 and the version, so an interrupted run leaves the old log untouched. Run it with `-bail`: without that flag the CLI continues past an error and commits what it has.

   First take the entry count and check the old table's columns; drop the `COALESCE` term from the `SELECT` when `refs` is absent:

```sh
sqlite3 -readonly changes.db "SELECT count(*) FROM entries;"
sqlite3 -readonly changes.db "PRAGMA table_info(entries);"
```

```sh
sqlite3 -bail changes.db <<'KLAWDE_SQL'
BEGIN;
CREATE TABLE entries_new (
  serial INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (date('now','localtime'))
       CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  type TEXT NOT NULL CHECK (type IN ('decided','done','changed')),
  description TEXT NOT NULL CHECK (description <> '')
);
INSERT INTO entries_new (serial, date, type, description)
  SELECT serial, date, 'done', description || COALESCE(' (' || refs || ')', '')
  FROM entries ORDER BY serial;
DROP VIEW IF EXISTS log_lines;
DROP VIEW IF EXISTS concern_lines;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS areas;
DROP TABLE IF EXISTS concerns;
DROP TABLE IF EXISTS legacy_summaries;
ALTER TABLE entries_new RENAME TO entries;
<the tasks table, the seven triggers and both views, copied verbatim from the schema file>
<one INSERT INTO tasks (task) VALUES ('<task>'); for each concern the user approved in step 4>
<the PRAGMA user_version line, copied from the schema file>
COMMIT;
KLAWDE_SQL
```

   Copy from the schema file only the statements that create `tasks`, the seven triggers and the two views, and its `PRAGMA user_version` line; this transaction supplies its own `BEGIN` and `COMMIT`, and the `entries` block above replaces the file's. Copy the statements as written. Escape the approved task text as `klawde-sql.md` says.

   Done when `PRAGMA user_version` reads the shipped version and `SELECT count(*) FROM entries` equals the count taken before the transaction.

6. **Brief, guided.** If the brief already has exactly the four fields, say so and skip to the removed fields. Otherwise ask one numbered round: Q1 `Purpose`, Q2 `Scope`, Q3 `Key decisions`, Q4 `Areas`, each with `Recommended: <the exact line built from the existing file's content>`, an empty line being a valid recommendation, each worded so "yes" accepts. Then, in the same round, one question per item found under the removed fields (Current focus, Next steps, Non-goals, Breaking-change context, Do-not-touch, Environment quirks, Open questions), showing the item's text, with `Recommended: task` for a Current focus or Next steps item that names real work and `Recommended: drop` otherwise. Wait. Write only the approved field lines and task rows. Done when every field has an approved line or is approved empty, and every removed item has an answer.

7. **guidelines.md.** If it is absent, say that this version keeps the code rules in `guidelines.md`, that the file is the user's and upgrades leave it alone, and offer to install it from the klawde checkout at `template/guidelines.md`. Install it only if the user says yes; an absent file is a valid choice. Done when the user has answered.

8. Report, then stop:

```
Migration complete.
changes.db: <N> entries migrated to `done`; <M> tasks created; backup at <path>.
Dropped: <concerns | areas | links | legacy summaries | none>.
BRIEFING.md: <fields written> | unchanged.
guidelines.md: <installed | left absent | already present>.
```

   `<N>` is the step 5 entry count; `<M>` is `SELECT count(*) FROM tasks;` after the last write.
