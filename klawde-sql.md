# klawde-sql.md

How the harness writes to and reads from `changes.db`. Read before the first write of a session.

Authored text, including the text of a filtered read, goes through a **quoted heredoc**: keep the delimiter quoted, pick a delimiter absent as a standalone line in the content, and double SQL apostrophes (`don''t`). A quoted heredoc keeps backticks, `$()`, dollar signs and double quotes as literal data; a double-quoted argument or `eval` would expand them. The heredoc prevents shell expansion; SQL apostrophe escaping is still required. Stop on a failed write. (These statements are the harness's own, against its own log; project code follows the parameterized-SQL rule in `guidelines.md` instead.)

SQL forms containing `<...>` are incomplete. Replace every placeholder before execution: text comes from the actual project and session, identifiers are integers read back from the database. Escape text as above. Never store placeholder text or guess an identifier. Each insert form prints the new serial or id; that printed number is the one to report.

```sh
sqlite3 -bail changes.db <<'KLAWDE_SQL'
INSERT INTO entries (type, description) VALUES ('<type>','<description>');
SELECT last_insert_rowid();
KLAWDE_SQL

sqlite3 -bail changes.db <<'KLAWDE_SQL'
INSERT INTO tasks (task) VALUES ('<task>');
SELECT last_insert_rowid();
KLAWDE_SQL

# Completing a task: one transaction, so the log and the table cannot disagree.
sqlite3 -bail changes.db <<'KLAWDE_SQL'
BEGIN;
INSERT INTO entries (type, description) VALUES ('done','<description>');
DELETE FROM tasks WHERE id = <task_id>;
COMMIT;
KLAWDE_SQL

sqlite3 -bail changes.db <<'KLAWDE_SQL'
UPDATE tasks SET task = '<task>' WHERE id = <task_id>;
KLAWDE_SQL

sqlite3 -bail changes.db "DELETE FROM tasks WHERE id = <task_id>;"

sqlite3 -readonly changes.db "SELECT line FROM log_lines ORDER BY serial DESC LIMIT 5;"
sqlite3 -readonly changes.db "SELECT line FROM task_lines ORDER BY id;"
sqlite3 -readonly changes.db "SELECT count(*) FROM tasks;"
```
