PRAGMA user_version = 2;

CREATE TABLE areas (
  name TEXT PRIMARY KEY CHECK (name <> '')
) WITHOUT ROWID;

CREATE TABLE entries (
  serial      INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL DEFAULT (date('now','localtime'))
              CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  type        TEXT NOT NULL CHECK (type IN ('decision','plan','doc','scope','code','note')),
  area        TEXT NOT NULL DEFAULT '-',
  description TEXT NOT NULL CHECK (description <> ''),
  refs        TEXT
);

CREATE TABLE links (
  from_serial INTEGER NOT NULL,
  to_serial   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('supersedes','closes')),
  PRIMARY KEY (from_serial, to_serial, kind),
  CHECK (from_serial > to_serial)
) WITHOUT ROWID;

CREATE TABLE legacy_summaries (
  month TEXT NOT NULL, area TEXT NOT NULL, description TEXT NOT NULL
);

CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
  BEGIN SELECT RAISE(ABORT, 'log entries are immutable'); END;
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
  BEGIN SELECT RAISE(ABORT, 'log entries are never deleted'); END;
CREATE TRIGGER links_no_update BEFORE UPDATE ON links
  BEGIN SELECT RAISE(ABORT, 'links are immutable'); END;
CREATE TRIGGER links_no_delete BEFORE DELETE ON links
  BEGIN SELECT RAISE(ABORT, 'links are never deleted'); END;
CREATE TRIGGER areas_no_update BEFORE UPDATE ON areas
  BEGIN SELECT RAISE(ABORT, 'areas are never renamed; log entries reference them'); END;
CREATE TRIGGER areas_no_delete BEFORE DELETE ON areas
  BEGIN SELECT RAISE(ABORT, 'areas are never removed; log entries reference them'); END;

CREATE TRIGGER entries_area_known BEFORE INSERT ON entries
  WHEN NEW.area <> '-' AND NOT EXISTS (SELECT 1 FROM areas WHERE name = NEW.area)
  BEGIN SELECT RAISE(ABORT, 'unknown area; add it to BRIEFING.md and the areas table first'); END;
CREATE TRIGGER entries_no_backfill AFTER INSERT ON entries
  WHEN NEW.serial < (SELECT max(serial) FROM entries)
  BEGIN SELECT RAISE(ABORT, 'serials append only; never insert between or below existing entries'); END;
CREATE TRIGGER links_serials_exist BEFORE INSERT ON links
  WHEN NOT EXISTS (SELECT 1 FROM entries WHERE serial = NEW.from_serial)
    OR NOT EXISTS (SELECT 1 FROM entries WHERE serial = NEW.to_serial)
  BEGIN SELECT RAISE(ABORT, 'link names a serial that does not exist'); END;

CREATE VIEW log_lines AS
  SELECT e.serial,
    printf('%s %03d [%s] (%s) %s', e.date, e.serial, e.type, e.area, e.description)
    || COALESCE('  ' || (SELECT group_concat(l.kind || '=' || printf('%03d', l.to_serial), ' ')
                         FROM links l WHERE l.from_serial = e.serial), '')
    || COALESCE('  refs=' || e.refs, '') AS line
  FROM entries e;
