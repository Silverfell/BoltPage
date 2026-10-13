BEGIN;

CREATE TABLE entries (
  serial      INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL DEFAULT (date('now','localtime'))
              CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  type        TEXT NOT NULL CHECK (type IN ('decided','done','changed')),
  description TEXT NOT NULL CHECK (description <> '')
);

CREATE TABLE tasks (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  date  TEXT NOT NULL DEFAULT (date('now','localtime'))
        CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  task  TEXT NOT NULL CHECK (task <> '')
);

-- The log is immutable. These five triggers are the whole of that guarantee.
-- INSERT OR REPLACE would otherwise rewrite a row without firing the update
-- trigger, and an explicit low serial would insert below the maximum, so the
-- insert path is guarded on both counts.
CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
  BEGIN SELECT RAISE(ABORT, 'log entries are immutable'); END;
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
  BEGIN SELECT RAISE(ABORT, 'log entries are never deleted'); END;
CREATE TRIGGER entries_no_replace BEFORE INSERT ON entries
  WHEN NEW.serial IS NOT NULL AND EXISTS (SELECT 1 FROM entries WHERE serial = NEW.serial)
  BEGIN SELECT RAISE(ABORT, 'serials are never reused'); END;
CREATE TRIGGER entries_no_backfill AFTER INSERT ON entries
  WHEN NEW.serial < (SELECT max(serial) FROM entries)
  BEGIN SELECT RAISE(ABORT, 'serials append only; never insert below an existing entry'); END;
CREATE TRIGGER entries_well_formed BEFORE INSERT ON entries
  WHEN trim(NEW.description) = '' OR length(NEW.description) > 600
    OR instr(NEW.description, char(10)) > 0 OR instr(NEW.description, char(13)) > 0
    OR date(NEW.date) IS NOT NEW.date
  BEGIN SELECT RAISE(ABORT, 'an entry is one non-blank line of at most 600 characters with a real date'); END;

-- Tasks are mutable and deletable; only their shape is enforced, on both paths.
CREATE TRIGGER tasks_well_formed_insert BEFORE INSERT ON tasks
  WHEN trim(NEW.task) = '' OR length(NEW.task) > 600
    OR instr(NEW.task, char(10)) > 0 OR instr(NEW.task, char(13)) > 0
    OR date(NEW.date) IS NOT NEW.date
  BEGIN SELECT RAISE(ABORT, 'a task is one non-blank line of at most 600 characters with a real date'); END;
CREATE TRIGGER tasks_well_formed_update BEFORE UPDATE ON tasks
  WHEN trim(NEW.task) = '' OR length(NEW.task) > 600
    OR instr(NEW.task, char(10)) > 0 OR instr(NEW.task, char(13)) > 0
    OR date(NEW.date) IS NOT NEW.date
  BEGIN SELECT RAISE(ABORT, 'a task is one non-blank line of at most 600 characters with a real date'); END;

CREATE VIEW log_lines AS
  SELECT serial, printf('%s %03d [%s] %s', date, serial, type, description) AS line
  FROM entries;

CREATE VIEW task_lines AS
  SELECT id, printf('%s #%02d %s', date, id, task) AS line
  FROM tasks;

PRAGMA user_version = 8;

COMMIT;
