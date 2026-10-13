---
name: upgrade_klawde
description: "Run only when explicitly invoked, after upgrade.sh. Klawde record migration: bring an older changes.db to the current schema and rewrite BRIEFING.md to its four fields, with the user approving each step."
---

# $upgrade_klawde: Record Migration

Run once, after `upgrade.sh` has copied the new files. This command migrates records. It never writes harness files. It is the only protocol allowed to rewrite the log, and it does so once.

Nothing is destroyed before every question about it has been answered, and the conversion is a single transaction: it either completes or leaves the log exactly as it was, ready for another run.

## Steps

1. Run `command -v sqlite3`; if it is missing, stop and request installation of the SQLite CLI. Run `ls BRIEFING.md changes.db 2>/dev/null`. Read the version only if `changes.db` exists:

```sh
sqlite3 -readonly changes.db "PRAGMA user_version;"
```

   Then take exactly one branch:

   - Neither record exists → nothing to migrate. Recommend `$klawde`. Stop.
   - `changes.db` absent, `BRIEFING.md` present → create the log first, so the brief's work has somewhere to go, then skip to step 5:

```sh
sqlite3 -bail changes.db < .agents/changes-schema.sql
```

   - `changes.db` present, version 0 → it holds no schema. Stop: "remove changes.db and run `$klawde`."
   - `changes.db` present, version above 8 → stop: the project is newer than this checkout.
   - `changes.db` present, version 8 → the log is already migrated. Skip to step 5.
   - `changes.db` present, version 1 to 7 → continue with steps 2 to 4.

2. Copy the database before any write, and say where the copy is:

```sh
cp changes.db changes.db.pre-gaiden.$(date +%Y%m%d-%H%M%S)
```

3. **Concerns, decided before anything is destroyed.** A `concerns` table exists only at version 3 and above, and its `evidence` column only at version 7, so read what the version says is there:

```sh
# version 7
sqlite3 -readonly changes.db "SELECT id, concern, evidence FROM concerns WHERE resolved IS NULL ORDER BY id;"
# versions 3 to 6
sqlite3 -readonly changes.db "SELECT id, concern FROM concerns WHERE resolved IS NULL ORDER BY id;"
# versions 1 to 2: no concerns table; read nothing.
```

   Show each open row and ask whether it becomes a task or is dropped. Resolved concerns go with the table. Nothing carries over without the user's word. Ask here, while the table still exists: a session that ends during these questions loses nothing, because the next run still reads version 1 to 7 and asks again.

4. **Migrate, in one transaction.** Serials and dates are preserved; every entry becomes `done`; a non-null `refs` value is appended to the description in parentheses, untruncated — the triggers arrive after the copy, so a long row is fine and nothing is cut. Views are dropped before the rename; every drop is `IF EXISTS`, because a v1 or v2 log has no `concerns` table and an older one has no views.

   Everything is in the transaction, including the tasks approved in step 3 and the version. An interrupted run therefore leaves the old log untouched rather than a half-converted one. Run it with `-bail`: without that flag the CLI continues past an error and commits what it has.

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
<the tasks table, the seven triggers and both views, copied verbatim from `.agents/changes-schema.sql`>
<one INSERT INTO tasks (task) VALUES ('<task>'); for each concern the user approved in step 3>
PRAGMA user_version = 8;
COMMIT;
KLAWDE_SQL
```

   Copy from `.agents/changes-schema.sql` only the statements that create `tasks`, the seven triggers and the two views. Leave out that file's own `BEGIN`, `COMMIT` and `PRAGMA` lines and its `entries` block; this transaction supplies those. Copy the statements as written; do not retype or reformat them. Escape the approved task text under the contract's Writing SQL safely.

   If the old `entries` table has no `refs` column (it always does from v1, but verify rather than assume), drop the `COALESCE` term from the `SELECT`.

5. **Brief, guided.** For each of the four new fields in order — `Purpose`, `Scope`, `Key decisions`, `Areas` — propose the exact text built from the existing file's content and write only what the user approves. If the brief already has exactly the four fields, say so and change nothing. Then show the content of the removed fields — Current focus, Next steps, Non-goals, Breaking-change context, Do-not-touch, Environment quirks, Open questions — and ask per item whether it becomes a task or is dropped. Current focus and Next steps are proposed as tasks first, since they usually hold real work.

6. **guidelines.md.** If it does not exist, say that this version keeps the code rules in `guidelines.md`, that upgrades never write it, and offer to install it from the klawde checkout at `template/guidelines.md`. Install it only if the user says yes; an absent file is a valid choice.

7. Report, then stop:

```
Migration complete.
changes.db: <N> entries migrated to `done`; <M> tasks created; backup at <path>.
Dropped: <concerns | areas | links | legacy summaries | none>.
BRIEFING.md: <fields written> | unchanged.
guidelines.md: <installed | left absent | already present>.
```
